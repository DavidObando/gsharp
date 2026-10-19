#include "textflag.h"
#include "constants.h"

TEXT ·assemblyValue(SB),NOSPLIT,$0-8
	MOVD $NATIVE_VALUE, R0
	MOVD R0, ret+0(FP)
	RET
