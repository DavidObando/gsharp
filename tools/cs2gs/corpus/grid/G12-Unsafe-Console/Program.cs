// G12-Unsafe-Console: unsafe/pointer construct grid fixtures (ADR-0115).
// One construct per Constructs/<Kind>.cs file; fixtures run sequentially in
// file-name order and print deterministic, prefix-tagged lines.
//
// NOTE (issue #1933): pointer / stackalloc IL is unverifiable BY DESIGN — the
// csc-compiled baseline of these fixtures fails ILVerify with the same error
// codes (ExpectedNumericType / Unverifiable / StackUnexpected). This app opts
// into stage 3's per-app `ilverify.allow-unsafe` policy (a sibling marker
// file, see CorpusDiscovery.AllowUnsafeIlMarkerFileName and
// IlVerifyStage.ExecuteAsync), which treats an ilverify failure as expected
// rather than gating, so FixedStatement/PointerType/StackAlloc now run
// end-to-end. FunctionPointerType, PointerMemberAccess, and RefType stay
// quarantined — those fail earlier (stage 1 translate / gsc compile),
// unrelated to the unsafe-IL policy.
using System;
using Corpus.Grid12.Constructs;

namespace Corpus.Grid12
{
    internal static class Program
    {
        private static void Main()
        {
            FixedStatementFixture.Run();

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

            PointerTypeFixture.Run();

            // QUARANTINED: RefType (ref locals / ref returns). Stage 1 fails
            // with CS2GS-GAP: "expression 'RefExpression' has no canonical G#
            // form yet; emitted an identifier placeholder (ADR-0115 §B)." for
            // `ref data[0]`, `ref Middle(data)`, and `return ref values[1]`.
            // See Constructs/RefType.cs.quarantined.
            // RefTypeFixture.Run();

            ScopedTypeFixture.Run();
            SizeOfExpressionFixture.Run();
            StackAllocArrayCreationExpressionFixture.Run();
            UnsafeStatementFixture.Run();
        }
    }
}
