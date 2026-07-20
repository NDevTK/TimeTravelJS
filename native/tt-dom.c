/*
 * TimeTravelJS DOM layer: Lexbor embedded in the SAME linear memory as the
 * interpreter, so the whole DOM tree + CSSOM is part of every per-step COW
 * snapshot — scrubbing the timeline rewinds the document atomically with
 * the JS heap, and forks fork the DOM. Nothing here is snapshot-aware: the
 * write barrier instruments Lexbor's stores like everyone else's.
 *
 * The C surface is deliberately tiny: pointer-based leaf primitives on a
 * `__dom` global (each runs to completion between steps — no user-code
 * reentry, so DOM calls never suppress a snapshot). The actual DOM API
 * (document, Node/Element prototypes, events, style facades) is
 * self-hosted in the setup runtime, where user callbacks park like any
 * other bytecode.
 *
 * Nodes are never freed during a session (removeChild only unlinks), so
 * the integer handles JS holds stay valid across every restore; document
 * teardown happens only at whole-session reset.
 */
#include <string.h>
#include <stdlib.h>

#include "quickjs.h"

#include <lexbor/html/html.h>
#include <lexbor/dom/dom.h>
#include <lexbor/css/css.h>
#include <lexbor/selectors/selectors.h>
#include <lexbor/style/style.h>

static lxb_html_document_t *g_dom_doc;
static lxb_selectors_t *g_dom_sel;

/* selector lists live in the parser's per-parse memory: use a fresh
   parser per call and free both together (a destroyed list's memory is
   the parser's own, so a session-long parser would dangle) */
static lxb_css_selector_list_t *tt_dom_parse_selectors(const char *sel, size_t slen,
                                                       lxb_css_parser_t **pparser)
{
    lxb_css_parser_t *p = lxb_css_parser_create();
    lxb_css_selector_list_t *list;
    if (!p || lxb_css_parser_init(p, NULL) != LXB_STATUS_OK) {
        if (p)
            lxb_css_parser_destroy(p, true);
        return NULL;
    }
    list = lxb_css_selectors_parse(p, (const lxb_char_t *)sel, slen);
    if (!list || p->status != LXB_STATUS_OK) {
        lxb_css_parser_destroy(p, true);
        return NULL;
    }
    *pparser = p;
    return list;
}

static void tt_dom_free_selectors(lxb_css_parser_t *p,
                                  lxb_css_selector_list_t *list)
{
    lxb_css_selector_list_destroy_memory(list);
    lxb_css_parser_destroy(p, true);
}

/* ---- growable output buffer for serializers -------------------------- */
typedef struct {
    char *p;
    size_t len, cap;
} tt_buf_t;

static lxb_status_t tt_buf_cb(const lxb_char_t *data, size_t len, void *ctx)
{
    tt_buf_t *b = ctx;
    if (b->len + len + 1 > b->cap) {
        size_t ncap = b->cap ? b->cap * 2 : 256;
        while (ncap < b->len + len + 1)
            ncap *= 2;
        char *np = realloc(b->p, ncap);
        if (!np)
            return LXB_STATUS_ERROR_MEMORY_ALLOCATION;
        b->p = np;
        b->cap = ncap;
    }
    memcpy(b->p + b->len, data, len);
    b->len += len;
    return LXB_STATUS_OK;
}

/* ---- handle plumbing -------------------------------------------------- */
static lxb_dom_node_t *tt_dom_node_arg(JSContext *ctx, JSValueConst v)
{
    uint32_t u = 0;
    JS_ToUint32(ctx, &u, v);
    return (lxb_dom_node_t *)(uintptr_t)u;
}

/* every node pointer ever handed to JS, so the engine-side serializer can
   tell a real wrapper from a forged { __p } object before dereferencing.
   Open-addressed set; cleared with the document. */
static uint32_t *g_dom_issued;
static size_t g_dom_issued_cap;
static size_t g_dom_issued_len;

static void tt_dom_issue(uint32_t h)
{
    size_t i, mask;
    if (!h)
        return;
    if (g_dom_issued_len * 2 >= g_dom_issued_cap) {
        size_t ncap = g_dom_issued_cap ? g_dom_issued_cap * 2 : 256;
        uint32_t *nt = calloc(ncap, sizeof(*nt));
        if (!nt)
            return;
        for (i = 0; i < g_dom_issued_cap; i++) {
            uint32_t v = g_dom_issued[i];
            if (v) {
                size_t j = (v * 2654435761u) & (ncap - 1);
                while (nt[j])
                    j = (j + 1) & (ncap - 1);
                nt[j] = v;
            }
        }
        free(g_dom_issued);
        g_dom_issued = nt;
        g_dom_issued_cap = ncap;
    }
    mask = g_dom_issued_cap - 1;
    i = (h * 2654435761u) & mask;
    while (g_dom_issued[i]) {
        if (g_dom_issued[i] == h)
            return;
        i = (i + 1) & mask;
    }
    g_dom_issued[i] = h;
    g_dom_issued_len++;
}

int tt_dom_ptr_known(uint32_t h)
{
    size_t i, mask;
    if (!h || !g_dom_issued_cap)
        return 0;
    mask = g_dom_issued_cap - 1;
    i = (h * 2654435761u) & mask;
    while (g_dom_issued[i]) {
        if (g_dom_issued[i] == h)
            return 1;
        i = (i + 1) & mask;
    }
    return 0;
}

static JSValue tt_dom_node_ret(JSContext *ctx, void *node)
{
    tt_dom_issue((uint32_t)(uintptr_t)node);
    return JS_NewUint32(ctx, (uint32_t)(uintptr_t)node);
}

/* ---- C-side views for the engine's native serializer ------------------ */
int tt_dom_has_doc_c(void)
{
    return g_dom_doc != NULL;
}

uint32_t tt_dom_doc_ptr(void)
{
    tt_dom_issue((uint32_t)(uintptr_t)g_dom_doc);
    return (uint32_t)(uintptr_t)g_dom_doc;
}

/* malloc'd serialization of a node (deep = children only, else the whole
   subtree including the node) — mirrors js_dom_serialize */
char *tt_dom_serialize_ptr(uint32_t h, int deep, size_t *plen)
{
    lxb_dom_node_t *node = (lxb_dom_node_t *)(uintptr_t)h;
    tt_buf_t buf = { 0 };
    *plen = 0;
    if (!node || !tt_dom_ptr_known(h))
        return NULL;
    if (deep)
        lxb_html_serialize_deep_cb(node, tt_buf_cb, &buf);
    else
        lxb_html_serialize_tree_cb(node, tt_buf_cb, &buf);
    if (!buf.p)
        return NULL;
    buf.p[buf.len] = 0;
    *plen = buf.len;
    return buf.p;
}

const char *tt_dom_node_name_ptr(uint32_t h, size_t *plen)
{
    lxb_dom_node_t *node = (lxb_dom_node_t *)(uintptr_t)h;
    *plen = 0;
    if (!node || !tt_dom_ptr_known(h))
        return NULL;
    return (const char *)lxb_dom_node_name(node, plen);
}

static const char *tt_dom_str_arg(JSContext *ctx, JSValueConst v, size_t *len)
{
    return JS_ToCStringLen(ctx, len, v);
}

/* ---- lifecycle -------------------------------------------------------- */
void tt_dom_destroy(void)
{
    if (g_dom_sel) {
        lxb_selectors_destroy(g_dom_sel, true);
        g_dom_sel = NULL;
    }
    if (g_dom_doc) {
        lxb_style_destroy(g_dom_doc);
        lxb_html_document_destroy(g_dom_doc);
        g_dom_doc = NULL;
    }
    free(g_dom_issued);
    g_dom_issued = NULL;
    g_dom_issued_cap = g_dom_issued_len = 0;
}

int tt_dom_load_html(const char *html, size_t len)
{
    tt_dom_destroy();
    g_dom_doc = lxb_html_document_create();
    if (!g_dom_doc)
        return 1;
    if (lxb_style_init(g_dom_doc) != LXB_STATUS_OK)
        return 2;
    if (lxb_html_document_parse(g_dom_doc, (const lxb_char_t *)html, len)
        != LXB_STATUS_OK)
        return 3;
    g_dom_sel = lxb_selectors_create();
    if (!g_dom_sel || lxb_selectors_init(g_dom_sel) != LXB_STATUS_OK)
        return 6;
    return 0;
}

/* ---- primitives ------------------------------------------------------- */
static JSValue js_dom_has_doc(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    return JS_NewBool(ctx, g_dom_doc != NULL);
}

static JSValue js_dom_doc(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    return tt_dom_node_ret(ctx, g_dom_doc);
}

static JSValue js_dom_body(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    return tt_dom_node_ret(ctx, g_dom_doc ? (void *)g_dom_doc->body : NULL);
}

static JSValue js_dom_head(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    return tt_dom_node_ret(ctx, g_dom_doc ? (void *)g_dom_doc->head : NULL);
}

static JSValue js_dom_doc_element(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_document_t *d = g_dom_doc ? lxb_dom_interface_document(g_dom_doc) : NULL;
    return tt_dom_node_ret(ctx, d ? (void *)d->element : NULL);
}

static JSValue js_dom_node_type(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);
    return JS_NewInt32(ctx, n ? (int)n->type : 0);
}

static JSValue js_dom_node_name(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);
    size_t len = 0;
    const lxb_char_t *s;
    if (!n)
        return JS_NULL;
    s = lxb_dom_node_name(n, &len);
    return s ? JS_NewStringLen(ctx, (const char *)s, len) : JS_NULL;
}

#define TT_DOM_NAV(fn, field)                                                \
static JSValue fn(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) \
{                                                                            \
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);                       \
    return tt_dom_node_ret(ctx, n ? (void *)n->field : NULL);                \
}
TT_DOM_NAV(js_dom_parent, parent)
TT_DOM_NAV(js_dom_first_child, first_child)
TT_DOM_NAV(js_dom_last_child, last_child)
TT_DOM_NAV(js_dom_next, next)
TT_DOM_NAV(js_dom_prev, prev)

static JSValue js_dom_create_element(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    size_t len;
    const char *name = tt_dom_str_arg(ctx, argv[0], &len);
    lxb_dom_element_t *el;
    if (!name || !g_dom_doc)
        return JS_NULL;
    el = lxb_dom_document_create_element(lxb_dom_interface_document(g_dom_doc),
                                         (const lxb_char_t *)name, len, NULL);
    JS_FreeCString(ctx, name);
    return tt_dom_node_ret(ctx, el);
}

static JSValue js_dom_create_text(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    size_t len;
    const char *s = tt_dom_str_arg(ctx, argv[0], &len);
    lxb_dom_text_t *n;
    if (!s || !g_dom_doc)
        return JS_NULL;
    n = lxb_dom_document_create_text_node(lxb_dom_interface_document(g_dom_doc),
                                          (const lxb_char_t *)s, len);
    JS_FreeCString(ctx, s);
    return tt_dom_node_ret(ctx, n);
}

static JSValue js_dom_create_comment(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    size_t len;
    const char *s = tt_dom_str_arg(ctx, argv[0], &len);
    lxb_dom_comment_t *n;
    if (!s || !g_dom_doc)
        return JS_NULL;
    n = lxb_dom_document_create_comment(lxb_dom_interface_document(g_dom_doc),
                                        (const lxb_char_t *)s, len);
    JS_FreeCString(ctx, s);
    return tt_dom_node_ret(ctx, n);
}

static JSValue js_dom_append(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *parent = tt_dom_node_arg(ctx, argv[0]);
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[1]);
    if (parent && node)
        lxb_dom_node_insert_child(parent, node);
    return JS_UNDEFINED;
}

static JSValue js_dom_insert_before(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *ref = tt_dom_node_arg(ctx, argv[0]);
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[1]);
    if (ref && node)
        lxb_dom_node_insert_before(ref, node);
    return JS_UNDEFINED;
}

static JSValue js_dom_remove(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    if (node)
        lxb_dom_node_remove(node); /* unlink only: handles stay valid */
    return JS_UNDEFINED;
}

static JSValue js_dom_clone(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    int deep = JS_ToBool(ctx, argv[1]);
    if (!node)
        return JS_NULL;
    return tt_dom_node_ret(ctx, lxb_dom_node_clone(node, deep));
}

static JSValue js_dom_text_get(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t len = 0;
    lxb_char_t *s;
    JSValue r;
    if (!node)
        return JS_NULL;
    s = lxb_dom_node_text_content(node, &len);
    r = s ? JS_NewStringLen(ctx, (const char *)s, len) : JS_NewString(ctx, "");
    if (s)
        lxb_dom_document_destroy_text(node->owner_document, s);
    return r;
}

static JSValue js_dom_text_set(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t len;
    const char *s = tt_dom_str_arg(ctx, argv[1], &len);
    if (node && s) {
        if (node->type == LXB_DOM_NODE_TYPE_TEXT ||
            node->type == LXB_DOM_NODE_TYPE_COMMENT) {
            lxb_dom_character_data_replace(
                lxb_dom_interface_character_data(node),
                (const lxb_char_t *)s, len, 0,
                lxb_dom_interface_character_data(node)->data.length);
        } else {
            /* unlink (never destroy) old children, then append one text */
            lxb_dom_node_t *c;
            lxb_dom_text_t *txt;
            while ((c = node->first_child) != NULL)
                lxb_dom_node_remove(c);
            if (len > 0 && node->owner_document) {
                txt = lxb_dom_document_create_text_node(node->owner_document,
                                                        (const lxb_char_t *)s, len);
                if (txt)
                    lxb_dom_node_insert_child(node, lxb_dom_interface_node(txt));
            }
        }
    }
    if (s)
        JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue js_dom_data_get(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    lxb_dom_character_data_t *cd;
    if (!node || (node->type != LXB_DOM_NODE_TYPE_TEXT &&
                  node->type != LXB_DOM_NODE_TYPE_COMMENT &&
                  node->type != LXB_DOM_NODE_TYPE_PROCESSING_INSTRUCTION))
        return JS_NULL;
    cd = lxb_dom_interface_character_data(node);
    return JS_NewStringLen(ctx, (const char *)cd->data.data, cd->data.length);
}

static JSValue js_dom_attr_get(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t nlen, vlen = 0;
    const char *name = tt_dom_str_arg(ctx, argv[1], &nlen);
    const lxb_char_t *v;
    JSValue r = JS_NULL;
    if (node && name && node->type == LXB_DOM_NODE_TYPE_ELEMENT) {
        lxb_dom_element_t *el = lxb_dom_interface_element(node);
        if (lxb_dom_element_has_attribute(el, (const lxb_char_t *)name, nlen)) {
            v = lxb_dom_element_get_attribute(el, (const lxb_char_t *)name, nlen, &vlen);
            r = JS_NewStringLen(ctx, v ? (const char *)v : "", vlen);
        }
    }
    if (name)
        JS_FreeCString(ctx, name);
    return r;
}

static JSValue js_dom_attr_set(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t nlen, vlen;
    const char *name = tt_dom_str_arg(ctx, argv[1], &nlen);
    const char *val = tt_dom_str_arg(ctx, argv[2], &vlen);
    if (node && name && val && node->type == LXB_DOM_NODE_TYPE_ELEMENT)
        lxb_dom_element_set_attribute(lxb_dom_interface_element(node),
                                      (const lxb_char_t *)name, nlen,
                                      (const lxb_char_t *)val, vlen);
    if (name)
        JS_FreeCString(ctx, name);
    if (val)
        JS_FreeCString(ctx, val);
    return JS_UNDEFINED;
}

static JSValue js_dom_attr_del(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t nlen;
    const char *name = tt_dom_str_arg(ctx, argv[1], &nlen);
    if (node && name && node->type == LXB_DOM_NODE_TYPE_ELEMENT)
        lxb_dom_element_remove_attribute(lxb_dom_interface_element(node),
                                         (const lxb_char_t *)name, nlen);
    if (name)
        JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_dom_attr_names(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    if (node && node->type == LXB_DOM_NODE_TYPE_ELEMENT) {
        lxb_dom_attr_t *attr = lxb_dom_element_first_attribute(lxb_dom_interface_element(node));
        while (attr) {
            size_t len = 0;
            const lxb_char_t *nm = lxb_dom_attr_qualified_name(attr, &len);
            if (nm)
                JS_SetPropertyUint32(ctx, arr, i++,
                                     JS_NewStringLen(ctx, (const char *)nm, len));
            attr = lxb_dom_element_next_attribute(attr);
        }
    }
    return arr;
}

static JSValue js_dom_inner_set(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t len;
    const char *html = tt_dom_str_arg(ctx, argv[1], &len);
    if (node && html && node->type == LXB_DOM_NODE_TYPE_ELEMENT) {
        /* unlink (never destroy) the old children first: JS-held handles
           must stay valid across the whole recording */
        lxb_dom_node_t *c;
        while ((c = node->first_child) != NULL)
            lxb_dom_node_remove(c);
        lxb_html_element_inner_html_set(lxb_html_interface_element(node),
                                        (const lxb_char_t *)html, len);
    }
    if (html)
        JS_FreeCString(ctx, html);
    return JS_UNDEFINED;
}

/* deep=1 → children only (innerHTML); deep=0 → whole tree (outerHTML) */
static JSValue js_dom_serialize(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    int32_t deep = 0;
    tt_buf_t buf = { 0 };
    JSValue r;
    JS_ToInt32(ctx, &deep, argv[1]);
    if (!node)
        return JS_NULL;
    if (deep)
        lxb_html_serialize_deep_cb(node, tt_buf_cb, &buf);
    else
        lxb_html_serialize_tree_cb(node, tt_buf_cb, &buf);
    r = JS_NewStringLen(ctx, buf.p ? buf.p : "", buf.len);
    free(buf.p);
    return r;
}

typedef struct {
    JSContext *ctx;
    JSValue arr;
    uint32_t i;
} tt_find_ctx_t;

static lxb_status_t tt_find_cb(lxb_dom_node_t *node,
                               lxb_css_selector_specificity_t spec, void *ud)
{
    tt_find_ctx_t *fc = ud;
    /* the same node can be reported once per matching complex selector */
    if (fc->i > 0) {
        JSValue last = JS_GetPropertyUint32(fc->ctx, fc->arr, fc->i - 1);
        uint32_t lu = 0;
        JS_ToUint32(fc->ctx, &lu, last);
        JS_FreeValue(fc->ctx, last);
        if ((uintptr_t)lu == (uintptr_t)node)
            return LXB_STATUS_OK;
    }
    JS_SetPropertyUint32(fc->ctx, fc->arr, fc->i++, tt_dom_node_ret(fc->ctx, node));
    return LXB_STATUS_OK;
}

static JSValue js_dom_qsa(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *root = tt_dom_node_arg(ctx, argv[0]);
    size_t slen;
    const char *sel = tt_dom_str_arg(ctx, argv[1], &slen);
    lxb_css_selector_list_t *list;
    lxb_css_parser_t *p;
    tt_find_ctx_t fc;
    if (!root || !sel || !g_dom_doc) {
        if (sel)
            JS_FreeCString(ctx, sel);
        return JS_ThrowTypeError(ctx, "querySelector on empty document");
    }
    list = tt_dom_parse_selectors(sel, slen, &p);
    JS_FreeCString(ctx, sel);
    if (!list)
        return JS_ThrowTypeError(ctx, "invalid selector");
    lxb_selectors_clean(g_dom_sel);
    fc.ctx = ctx;
    fc.arr = JS_NewArray(ctx);
    fc.i = 0;
    lxb_selectors_find(g_dom_sel, root, list, tt_find_cb, &fc);
    tt_dom_free_selectors(p, list);
    return fc.arr;
}

static lxb_status_t tt_match_cb(lxb_dom_node_t *node,
                                lxb_css_selector_specificity_t spec, void *ud)
{
    *(int *)ud = 1;
    return LXB_STATUS_OK;
}

static JSValue js_dom_matches(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    size_t slen;
    const char *sel = tt_dom_str_arg(ctx, argv[1], &slen);
    lxb_css_selector_list_t *list;
    lxb_css_parser_t *p;
    int hit = 0;
    if (!node || !sel || !g_dom_doc) {
        if (sel)
            JS_FreeCString(ctx, sel);
        return JS_FALSE;
    }
    list = tt_dom_parse_selectors(sel, slen, &p);
    JS_FreeCString(ctx, sel);
    if (!list)
        return JS_ThrowTypeError(ctx, "invalid selector");
    lxb_selectors_clean(g_dom_sel);
    lxb_selectors_match_node(g_dom_sel, node, list, tt_match_cb, &hit);
    tt_dom_free_selectors(p, list);
    return JS_NewBool(ctx, hit);
}

static JSValue js_dom_by_attr(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *root = tt_dom_node_arg(ctx, argv[0]);
    size_t nlen, vlen;
    const char *name = tt_dom_str_arg(ctx, argv[1], &nlen);
    const char *val = tt_dom_str_arg(ctx, argv[2], &vlen);
    lxb_dom_collection_t *col;
    JSValue r = JS_NULL;
    if (root && name && val && g_dom_doc &&
        root->type != LXB_DOM_NODE_TYPE_TEXT) {
        col = lxb_dom_collection_make(lxb_dom_interface_document(g_dom_doc), 4);
        if (col) {
            lxb_dom_elements_by_attr(lxb_dom_interface_element(
                root->type == LXB_DOM_NODE_TYPE_DOCUMENT
                    ? (lxb_dom_node_t *)lxb_dom_interface_document(g_dom_doc)->element
                    : root),
                col, (const lxb_char_t *)name, nlen,
                (const lxb_char_t *)val, vlen, true);
            if (lxb_dom_collection_length(col) > 0)
                r = tt_dom_node_ret(ctx, lxb_dom_collection_element(col, 0));
            lxb_dom_collection_destroy(col, true);
        }
    }
    if (name)
        JS_FreeCString(ctx, name);
    if (val)
        JS_FreeCString(ctx, val);
    return r;
}

/* fresh selector re-match of one element against every attached
   stylesheet (Lexbor's mutation steps only track the style attribute, so
   class/attribute changes require matching at read time). Returns a flat
   array [specificity, "decls", specificity, "decls", ...] in document
   order; the setup runtime cascades. */
typedef struct {
    uint32_t max_spec;
    int hit;
} tt_match_spec_t;

static lxb_status_t tt_match_spec_cb(lxb_dom_node_t *node,
                                     lxb_css_selector_specificity_t spec,
                                     void *ud)
{
    tt_match_spec_t *m = ud;
    m->hit = 1;
    if ((uint32_t)spec > m->max_spec)
        m->max_spec = (uint32_t)spec;
    return LXB_STATUS_OK;
}

static void tt_dom_match_rules(JSContext *ctx, lxb_dom_node_t *node,
                               lxb_css_rule_t *rule, JSValue arr, uint32_t *i)
{
    while (rule) {
        switch (rule->type) {
        case LXB_CSS_RULE_LIST:
            tt_dom_match_rules(ctx, node, lxb_css_rule_list(rule)->first, arr, i);
            break;
        case LXB_CSS_RULE_STYLE: {
            lxb_css_rule_style_t *st = lxb_css_rule_style(rule);
            tt_match_spec_t m = { 0, 0 };
            if (st->selector && st->declarations) {
                lxb_selectors_clean(g_dom_sel);
                lxb_selectors_match_node(g_dom_sel, node, st->selector,
                                         tt_match_spec_cb, &m);
                if (m.hit) {
                    tt_buf_t decl = { 0 };
                    lxb_css_rule_declaration_list_serialize(st->declarations,
                                                            tt_buf_cb, &decl);
                    JS_SetPropertyUint32(ctx, arr, (*i)++,
                                         JS_NewUint32(ctx, m.max_spec));
                    JS_SetPropertyUint32(ctx, arr, (*i)++,
                                         JS_NewStringLen(ctx, decl.p ? decl.p : "",
                                                         decl.len));
                    free(decl.p);
                }
            }
            break;
        }
        default:
            break;
        }
        rule = rule->next;
    }
}

static JSValue js_dom_computed(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *node = tt_dom_node_arg(ctx, argv[0]);
    lxb_dom_document_css_t *css;
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    size_t k;
    if (!node || node->type != LXB_DOM_NODE_TYPE_ELEMENT || !g_dom_doc)
        return arr;
    css = lxb_dom_interface_document(g_dom_doc)->css;
    if (!css || !css->stylesheets)
        return arr;
    for (k = 0; k < lexbor_array_length(css->stylesheets); k++) {
        lxb_css_stylesheet_t *sst = lexbor_array_get(css->stylesheets, k);
        if (sst && sst->root) {
            if (sst->root->type == LXB_CSS_RULE_LIST ||
                sst->root->type == LXB_CSS_RULE_STYLESHEET)
                tt_dom_match_rules(ctx, node,
                                   lxb_css_rule_list(sst->root)->first, arr, &i);
            else
                tt_dom_match_rules(ctx, node, sst->root, arr, &i);
        }
    }
    return arr;
}

/* stylesheet text appended at runtime (beyond <style> elements, which the
   mutation events handle) */
static JSValue js_dom_add_css(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    size_t len;
    const char *css = tt_dom_str_arg(ctx, argv[0], &len);
    lxb_css_stylesheet_t *sst;
    lxb_css_parser_t *p;
    if (!css || !g_dom_doc)
        return JS_UNDEFINED;
    p = lxb_css_parser_create();
    if (p && lxb_css_parser_init(p, NULL) == LXB_STATUS_OK) {
        sst = lxb_css_stylesheet_create(NULL);
        if (sst && lxb_css_stylesheet_parse(sst, p,
                                            (const lxb_char_t *)css, len)
            == LXB_STATUS_OK)
            lxb_html_document_stylesheet_attach(g_dom_doc, sst);
    }
    if (p)
        lxb_css_parser_destroy(p, true);
    JS_FreeCString(ctx, css);
    return JS_UNDEFINED;
}

static JSValue js_dom_ns(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);
    const char *nm = "";
    if (n && n->ns == LXB_NS_SVG)
        nm = "svg";
    else if (n && n->ns == LXB_NS_MATH)
        nm = "math";
    return JS_NewString(ctx, nm);
}

static JSValue js_dom_doctype_ids(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);
    JSValue arr = JS_NewArray(ctx);
    if (n && n->type == LXB_DOM_NODE_TYPE_DOCUMENT_TYPE) {
        lxb_dom_document_type_t *dt = lxb_dom_interface_document_type(n);
        size_t nlen = 0;
        const lxb_char_t *nm = lxb_dom_document_type_name(dt, &nlen);
        JS_SetPropertyUint32(ctx, arr, 0,
                             JS_NewStringLen(ctx, nm ? (const char *)nm : "", nlen));
        JS_SetPropertyUint32(ctx, arr, 1,
                             JS_NewStringLen(ctx, (const char *)dt->public_id.data,
                                             dt->public_id.length));
        JS_SetPropertyUint32(ctx, arr, 2,
                             JS_NewStringLen(ctx, (const char *)dt->system_id.data,
                                             dt->system_id.length));
    }
    return arr;
}

static JSValue js_dom_template_content(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv)
{
    lxb_dom_node_t *n = tt_dom_node_arg(ctx, argv[0]);
    if (n && n->type == LXB_DOM_NODE_TYPE_ELEMENT &&
        n->local_name == LXB_TAG_TEMPLATE && n->ns == LXB_NS_HTML) {
        lxb_html_template_element_t *te = lxb_html_interface_template(n);
        return tt_dom_node_ret(ctx, te->content);
    }
    return tt_dom_node_ret(ctx, NULL);
}

static const JSCFunctionListEntry tt_dom_funcs[] = {
    JS_CFUNC_DEF("hasDoc", 0, js_dom_has_doc),
    JS_CFUNC_DEF("doc", 0, js_dom_doc),
    JS_CFUNC_DEF("body", 0, js_dom_body),
    JS_CFUNC_DEF("head", 0, js_dom_head),
    JS_CFUNC_DEF("docElement", 0, js_dom_doc_element),
    JS_CFUNC_DEF("nodeType", 1, js_dom_node_type),
    JS_CFUNC_DEF("nodeName", 1, js_dom_node_name),
    JS_CFUNC_DEF("parent", 1, js_dom_parent),
    JS_CFUNC_DEF("firstChild", 1, js_dom_first_child),
    JS_CFUNC_DEF("lastChild", 1, js_dom_last_child),
    JS_CFUNC_DEF("next", 1, js_dom_next),
    JS_CFUNC_DEF("prev", 1, js_dom_prev),
    JS_CFUNC_DEF("createElement", 1, js_dom_create_element),
    JS_CFUNC_DEF("createText", 1, js_dom_create_text),
    JS_CFUNC_DEF("createComment", 1, js_dom_create_comment),
    JS_CFUNC_DEF("append", 2, js_dom_append),
    JS_CFUNC_DEF("insertBefore", 2, js_dom_insert_before),
    JS_CFUNC_DEF("remove", 1, js_dom_remove),
    JS_CFUNC_DEF("clone", 2, js_dom_clone),
    JS_CFUNC_DEF("textGet", 1, js_dom_text_get),
    JS_CFUNC_DEF("textSet", 2, js_dom_text_set),
    JS_CFUNC_DEF("dataGet", 1, js_dom_data_get),
    JS_CFUNC_DEF("attrGet", 2, js_dom_attr_get),
    JS_CFUNC_DEF("attrSet", 3, js_dom_attr_set),
    JS_CFUNC_DEF("attrDel", 2, js_dom_attr_del),
    JS_CFUNC_DEF("attrNames", 1, js_dom_attr_names),
    JS_CFUNC_DEF("innerSet", 2, js_dom_inner_set),
    JS_CFUNC_DEF("serialize", 2, js_dom_serialize),
    JS_CFUNC_DEF("qsa", 2, js_dom_qsa),
    JS_CFUNC_DEF("matches", 2, js_dom_matches),
    JS_CFUNC_DEF("byAttr", 3, js_dom_by_attr),
    JS_CFUNC_DEF("computed", 1, js_dom_computed),
    JS_CFUNC_DEF("addCss", 1, js_dom_add_css),
    JS_CFUNC_DEF("ns", 1, js_dom_ns),
    JS_CFUNC_DEF("doctypeIds", 1, js_dom_doctype_ids),
    JS_CFUNC_DEF("templateContent", 1, js_dom_template_content),
};

void tt_dom_register(JSContext *ctx)
{
    JSValue glob = JS_GetGlobalObject(ctx);
    JSValue dom = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, dom, tt_dom_funcs,
                               sizeof(tt_dom_funcs) / sizeof(tt_dom_funcs[0]));
    JS_SetPropertyStr(ctx, glob, "__dom", dom);
    JS_FreeValue(ctx, glob);
}
