/*
 * A tiny libmagic front end for the Linux console page.
 *
 * It exposes just enough of the library to do what file(1) does: load the
 * compiled database (magic.mgc) once, then identify a buffer of bytes.
 * mg_compile() is there so tools/build_libmagic.sh can regenerate magic.mgc
 * from the magic/Magdir sources with this exact build -- the database format
 * is versioned, so it has to be produced by the same library that reads it.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "magic.h"

static magic_t ms = NULL;

/* Returns 0 on success, or a malloc'd error string (free with mg_free). */
EMSCRIPTEN_KEEPALIVE
char *mg_open(int flags)
{
	char *err;
	if (ms != NULL)
		magic_close(ms);
	ms = magic_open(flags);
	if (ms == NULL)
		return strdup("magic_open failed");
	if (magic_setflags(ms, flags) != 0) {
		err = strdup(magic_error(ms));
		return err;
	}
	return NULL;
}

EMSCRIPTEN_KEEPALIVE
char *mg_load(const char *path)
{
	if (ms == NULL)
		return strdup("not open");
	if (magic_load(ms, path) != 0)
		return strdup(magic_error(ms));
	return NULL;
}

/* Compile magic source text (as `file -C` does) into `out`. */
EMSCRIPTEN_KEEPALIVE
char *mg_compile(const char *src, const char *out)
{
	if (ms == NULL)
		return strdup("not open");
	if (magic_compile(ms, src) != 0)
		return strdup(magic_error(ms));
	if (out != NULL) {
		/* magic_compile writes magic.mgc next to the source's directory;
		 * the build script copies it from there. */
		(void)out;
	}
	return NULL;
}

/* Identify LEN bytes at PTR; the answer lives in the library's buffer. */
EMSCRIPTEN_KEEPALIVE
const char *mg_check(const void *ptr, int len)
{
	const char *r;
	if (ms == NULL)
		return "libmagic not open";
	r = magic_buffer(ms, ptr, (size_t)len);
	return r ? r : magic_error(ms);
}

/* Identify the file at PATH.  readelf.c reaches into the program headers and
 * the PT_NOTE sections with pread(), so a buffer is not enough for a full ELF
 * description -- "pie executable, dynamically linked, interpreter ..." comes
 * from there.  Given a path inside the module's filesystem it is exactly what
 * file(1) does. */
EMSCRIPTEN_KEEPALIVE
const char *mg_check_file(const char *path)
{
	const char *r;
	if (ms == NULL)
		return "libmagic not open";
	r = magic_file(ms, path);
	return r ? r : magic_error(ms);
}

EMSCRIPTEN_KEEPALIVE
char *mg_error(void)
{
	if (ms == NULL)
		return strdup("not open");
	return strdup(magic_error(ms));
}

EMSCRIPTEN_KEEPALIVE
int mg_setflags(int flags)
{
	if (ms == NULL)
		return -1;
	return magic_setflags(ms, flags);
}

EMSCRIPTEN_KEEPALIVE
void mg_free(char *p) { free(p); }