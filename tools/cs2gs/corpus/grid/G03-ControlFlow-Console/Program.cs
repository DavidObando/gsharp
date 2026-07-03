// G03-ControlFlow-Console: differential C#->G# conformance fixtures for
// control-flow statements (ADR-0115). Deterministic stdout is the parity
// oracle. One construct per file under Constructs/; Run() methods are invoked
// in file-name order.
using Corpus.Grid03.Constructs;

namespace Corpus.Grid03
{
    internal static class Program
    {
        private static void Main()
        {
            BreakStatementFixture.Run();
            CatchFilterClauseFixture.Run();
            CheckedStatementFixture.Run();
            ContinueStatementFixture.Run();
            DoStatementFixture.Run();
            EmptyStatementFixture.Run();
            ForEachStatementFixture.Run();
            ForStatementFixture.Run();
            IfStatementFixture.Run();
            LocalFunctionStatementFixture.Run();
            LockStatementFixture.Run();
            ReturnStatementFixture.Run();
            SwitchStatementFixture.Run();
            ThrowStatementFixture.Run();
            TryStatementFixture.Run();
            UncheckedStatementFixture.Run();
            UsingStatementFixture.Run();
            WhileStatementFixture.Run();
            YieldBreakStatementFixture.Run();
            YieldReturnStatementFixture.Run();
        }
    }
}
