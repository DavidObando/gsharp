// G04-Patterns-Console: differential C#->G# conformance fixtures for pattern
// matching (ADR-0115). Deterministic stdout is the parity oracle. One pattern
// kind per file under Constructs/; Run() methods are invoked in file-name
// order.
using Corpus.Grid04.Constructs;

namespace Corpus.Grid04
{
    internal static class Program
    {
        private static void Main()
        {
            AndPatternFixture.Run();
            CasePatternSwitchLabelFixture.Run();
            ConstantPatternFixture.Run();
            DeclarationPatternFixture.Run();
            DiscardPatternFixture.Run();
            ExpressionColonFixture.Run();
            ListPatternFixture.Run();
            NotPatternFixture.Run();
            OrPatternFixture.Run();
            ParenthesizedPatternFixture.Run();
            PositionalPatternClauseFixture.Run();
            RecursivePatternFixture.Run();
            RelationalPatternFixture.Run();
            SwitchExpressionFixture.Run();
            TypePatternFixture.Run();
        }
    }
}
