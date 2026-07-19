/* wasm32-wasi shim: single-threaded build — mutexes are no-ops */
#ifndef _TT_PTHREAD_SHIM_H
#define _TT_PTHREAD_SHIM_H
typedef int pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER 0
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
#endif
