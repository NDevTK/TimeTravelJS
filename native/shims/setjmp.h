/* wasm32-wasi shim: quickjs's dtoa.c includes setjmp.h but never uses it */
#ifndef _TT_SETJMP_SHIM_H
#define _TT_SETJMP_SHIM_H
typedef int jmp_buf[1];
#define setjmp(env) ((void)(env), 0)
#define longjmp(env, val) __builtin_trap()
#endif
