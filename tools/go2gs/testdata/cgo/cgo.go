package cgofixture

/*
#include "native.h"
int answer(void) { return 42; }
*/
import "C"

var Value = int(C.NATIVE_VALUE)

func Answer() int {
	return int(C.answer())
}
