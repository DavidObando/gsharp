#include "textflag.h"
#include "constants.h"

TEXT ·assemblyValue(SB),NOSPLIT,$0-8
	MOVQ $NATIVE_VALUE, ret+0(FP)
	RET
