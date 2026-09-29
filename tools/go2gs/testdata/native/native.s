#include "textflag.h"

TEXT ·assemblyValue(SB),NOSPLIT,$0-8
	MOVQ $7, ret+0(FP)
	RET
