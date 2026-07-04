// G11-Linq-Console: differential C#->G# conformance fixtures for the LINQ
// query-expression clause matrix (from/select, where, multiple from, let,
// join, join-into, orderby, group, continuations, nesting) plus method-chain
// parity. One clause combo per file under Constructs/; Run() methods are
// invoked in file-name (ordinal) order. Deterministic stdout is the parity
// oracle.
namespace Corpus.Grid11
{
    internal static class Program
    {
        private static void Main()
        {
            FromClauseSelectManyFixture.Run();
            GroupClauseFixture.Run();
            JoinClauseFixture.Run();
            JoinIntoClauseFixture.Run();
            LetClauseFixture.Run();
            MethodChainParityFixture.Run();
            OrderByClauseFixture.Run();
            QueryContinuationFixture.Run();
            QueryExpressionFixture.Run();
            QueryExpressionNestedFixture.Run();
            WhereClauseFixture.Run();
        }
    }
}
