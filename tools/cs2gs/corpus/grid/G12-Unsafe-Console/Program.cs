// G12-Unsafe-Console: unsafe/pointer construct grid fixtures (ADR-0115).
// One construct per Constructs/<Kind>.cs file; fixtures run sequentially in
// file-name order and print deterministic, prefix-tagged lines.
//
// NOTE: the migration pipeline's stage 3 (ILVerify) has no unsafe exemption,
// and pointer / stackalloc IL is unverifiable BY DESIGN — the csc-compiled
// baseline of the quarantined fixtures fails ILVerify with the same error
// codes (ExpectedNumericType / Unverifiable / UnmanagedPointer / StackByRef).
// Only unsafe constructs with verifiable IL (sizeof, unsafe contexts with
// pointer-free bodies, scoped spans over arrays) can be green end-to-end.
using System;
using Corpus.Grid12.Constructs;

namespace Corpus.Grid12
{
    internal static class Program
    {
        private static void Main()
        {
            // QUARANTINED: FixedStatement. Stage 3 (ILVerify) — pointer IL is
            // unverifiable (ExpectedNumericType "found address of Int32"),
            // including on the csc-compiled baseline. Additionally gsc rejects
            // the emitted `*(p + i)` with GS0129 ('+=' not defined for 'int32'
            // and '**int32'); `p[i]` and hoisted `int* q = p + i` compile.
            // See Constructs/FixedStatement.cs.quarantined.
            // FixedStatementFixture.Run();

            // QUARANTINED: FunctionPointerType. Stage 1 (translate) fails with
            // CS2GS-GAP: "unsafe function-pointer type 'delegate*<int, int>'
            // has no canonical G# form; G# does not support function-pointer
            // types." See Constructs/FunctionPointerType.cs.quarantined.
            // FunctionPointerTypeFixture.Run();

            // QUARANTINED: PointerMemberAccessExpression (p->Field). The
            // translator emits `p->X` as `p.X`, and gsc fails with GS0158
            // "Cannot find member X." on a struct-pointer receiver (the
            // explicit `(*p).X` form does compile). Would also gate on
            // stage 3 like all pointer IL.
            // See PointerMemberAccessExpression.cs.quarantined.
            // PointerMemberAccessExpressionFixture.Run();

            // QUARANTINED: PointerType / AddressOfExpression /
            // PointerIndirectionExpression. Translates and compiles (gsc
            // handles `int* p = &x; *p = 5; **pp = 9`), but stage 3 (ILVerify)
            // rejects pointer IL — also on the csc baseline
            // (ExpectedNumericType / UnmanagedPointer / StackByRef).
            // See Constructs/PointerType.cs.quarantined.
            // PointerTypeFixture.Run();

            // QUARANTINED: RefType (ref locals / ref returns). Stage 1 fails
            // with CS2GS-GAP: "expression 'RefExpression' has no canonical G#
            // form yet; emitted an identifier placeholder (ADR-0115 §B)." for
            // `ref data[0]`, `ref Middle(data)`, and `return ref values[1]`.
            // See Constructs/RefType.cs.quarantined.
            // RefTypeFixture.Run();

            ScopedTypeFixture.Run();
            SizeOfExpressionFixture.Run();

            // QUARANTINED: StackAllocArrayCreationExpression. stackalloc emits
            // localloc, which ILVerify reports as Unverifiable — also on the
            // csc-compiled baseline (both the `int*` and the safe `Span<int>`
            // forms). gsc itself compiles the emitted `stackalloc [4]int32`.
            // See StackAllocArrayCreationExpression.cs.quarantined.
            // StackAllocArrayCreationExpressionFixture.Run();

            UnsafeStatementFixture.Run();
        }
    }
}
