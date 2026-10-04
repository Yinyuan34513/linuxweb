#!/bin/sh
# Build assets/libmagic.js -- file(1)'s own library as WebAssembly.
#
#   tools/build_libmagic.sh [file-source-dir]     (default: ../file)
#
# The directory must be a checkout of file/file at FILE5_45 -- the release
# whose magic.mgc the page ships, because magic_load() reads the database as
# raw `struct magic` records and that struct changed in 5.46:
#
#   git -C ../file fetch --depth 1 origin tag FILE5_45
#   git -C ../file worktree add ../file545 FILE5_45
#   sh tools/build_libmagic.sh ../file545
#
# src/{apprentice,softmagic,ascmagic,readelf,...}.c are compiled as-is; the
# only file we add is tools/libmagic_wasm.c, the exported entry points.
#
# Why wasm at all: the shell's `file` command used to guess from the first
# few bytes ("ASCII text" for everything).  With this, `file` runs the same
# softmagic/ascmagic/readelf code paths that file(1) does, so `file` on a
# tarball, an ELF, a gzip stream or a UTF-8 file answers what the real tool
# answers.
#
# Needs the Emscripten SDK.  If emcc is not on PATH, source it first:
#   . ~/gnos/emsdk/emsdk_env.sh
set -e

SRC=${1:-../file}
OUT=assets/libmagic.js

cd "$(dirname "$0")/.."

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found; source the Emscripten SDK first:" >&2
  echo "  . ~/gnos/emsdk/emsdk_env.sh" >&2
  exit 1
fi

[ -f "$SRC/src/apprentice.c" ] || { echo "no file(1) sources at $SRC" >&2; exit 1; }

# The source list is file(1)'s own libmagic_la_SOURCES (src/Makefile.am),
# filtered to what this checkout actually has -- swap.c and friends arrived
# after 5.45, and der.c/is_json.c before it.
SOURCES=""
for f in buffer.c magic.c apprentice.c softmagic.c ascmagic.c encoding.c \
         compress.c is_csv.c is_json.c is_simh.c is_tar.c readelf.c print.c \
         fsmagic.c funcs.c apptype.c der.c cdf.c cdf_time.c readcdf.c swap.c \
         fmtcheck.c missing/fmtcheck.c; do
  [ -f "$SRC/src/$f" ] && SOURCES="$SOURCES $SRC/src/$f"
done
echo "sources:$SOURCES" | tr ' ' '\n' | grep -c '\.c$' | xargs echo "compiling"

# autoconf normally generates src/config.h and src/magic.h; the sources
# include them by those names, so they go in a scratch include directory.
BUILD=tools/.wasmbuild
rm -rf "$BUILD" && mkdir -p "$BUILD"

# MAGIC_VERSION has to match the library: magic_load() refuses a database
# that was compiled by a different one.
VER=$(grep -oE 'AC_INIT\(\[file\],\[[0-9]+' "$SRC/configure.ac" | grep -oE '[0-9]+' | tr -d .)
sed -e "s/X.YY/$VER/" "$SRC/src/magic.h.in" > "$BUILD/magic.h"

# config.h stands in for the autoconf output; only the switches libmagic
# actually tests are needed, and it is Linux/glibc-shaped.
cat > "$BUILD/config.h" <<'EOF'
#ifndef LIBMAGIC_WASM_CONFIG_H
#define LIBMAGIC_WASM_CONFIG_H
#define PACKAGE "file"
#define _GNU_SOURCE 1
#define VERSION "5.45"
/* the built-in ELF reader (src/readelf.c): without it file(1) falls back to
 * the magic rules and never prints "pie executable, dynamically linked,
 * interpreter ..., BuildID[sha1]=..., stripped" */
#define BUILTIN_ELF 1
/* core-dump note parsing; readelf.c keeps the FLAGS_* bookkeeping for it in
 * the same block, and donote() refers to those flags outside it */
#define ELFCORE 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_SYS_SYSMACROS_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_DIRENT_H 1
#define HAVE_BYTESWAP_H 1
#define HAVE_REGEX_H 1
#define HAVE_WCHAR_H 1
#define HAVE_WCTYPE_H 1
#define HAVE_CTYPE_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LOCALE_H 1
#define HAVE_SIGNAL_H 1
#define HAVE_STDDEF_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_MEMORY_H 1
#define HAVE_ASCTIME_R 1
#define HAVE_CTIME_R 1
#define HAVE_GMTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_ASPRINTF 1
#define HAVE_VASPRINTF 1
#define HAVE_DPRINTF 1
#define HAVE_FORK 1
#define HAVE_GETLINE 1
#define HAVE_GETOPT_LONG 1
#define HAVE_MBRTOWC 1
#define HAVE_MEMMEM 1
#define HAVE_MKSTEMP 1
#define HAVE_MMAP 1
#define HAVE_NEWLOCALE 1
#define HAVE_PATHCONF 1
#define HAVE_PIPE 1
#define HAVE_PIPE2 1
#define HAVE_PREAD 1
#define HAVE_READLINK 1
#define HAVE_SELECT 1
#define HAVE_SIGACTION 1
#define HAVE_STRCASESTR 1
#define HAVE_STRNDUP 1
#define HAVE_STRTOF 1
#define HAVE_TZSET 1
#define HAVE_USELOCALE 1
#define HAVE_UTIME 1
#define HAVE_UTIMES 1
#define HAVE_WCWIDTH 1
#define HAVE_IOCTL 1
#define HAVE_STRUCT_STAT_ST_RDEV 1
#define HAVE_STRUCT_TM_TM_GMTOFF 1
#define HAVE_STRUCT_TM_TM_ZONE 1
#endif
EOF

echo "compiling libmagic -> $OUT"
emcc -O2 -DNDEBUG -DHAVE_CONFIG_H -DLIBHACK=1 \
  -DMAGIC='"/magic.mgc"' \
  -I "$BUILD" -I "$SRC/src" \
  -o "$OUT" \
  $SOURCES \
  tools/libmagic_wasm.c \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_mg_open","_mg_load","_mg_check","_mg_check_file","_mg_error","_mg_setflags","_mg_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","ccall","cwrap","HEAPU8","FS","lengthBytesUTF8"]' \
  -s SINGLE_FILE=1 \
  -s ENVIRONMENT="web,worker,node" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createLibmagic \
  -s FORCE_FILESYSTEM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432

rm -rf "$BUILD"

echo
echo "now compile the database against it:"
echo "  node tools/gen_magicmgc.js $OUT data/magic src/magicmgc.data.js"