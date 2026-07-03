// G09-Functions-Console: differential C#->G# conformance fixtures for
// function-shaped constructs (lambdas, anonymous methods, delegates, local
// functions, method groups, out/ref declarations, named/optional/params
// parameters). One construct per file under Constructs/; Run() methods are
// invoked in file-name (ordinal) order. Deterministic stdout is the parity
// oracle.
namespace Corpus.Grid09
{
    internal static class Program
    {
        private static void Main()
        {
            ConditionalAccessExpressionFixture.Run();
            DeclarationExpressionFixture.Run();
            LocalFunctionStatementGenericFixture.Run();
            MethodGroupConversionFixture.Run();
            NameColonFixture.Run();
            OptionalAndParamsArrayFixture.Run();
            ParenthesizedLambdaExpressionFixture.Run();
            ParenthesizedLambdaExpressionAsyncFixture.Run();
            ParenthesizedLambdaExpressionAttributedFixture.Run();
            SimpleLambdaExpressionFixture.Run();
        }
    }
}
