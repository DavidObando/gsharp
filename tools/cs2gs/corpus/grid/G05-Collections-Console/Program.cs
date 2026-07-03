// G05-Collections-Console: differential C#->G# conformance fixtures for
// collection-shaped constructs (arrays, initializers, collection expressions,
// index/range, stackalloc, tuples). One construct per file under Constructs/;
// Run() methods are invoked in file-name (ordinal) order. Deterministic stdout
// is the parity oracle.
namespace Corpus.Grid05
{
    internal static class Program
    {
        private static void Main()
        {
            AnonymousObjectCreationExpressionFixture.Run();
            ArrayCreationExpressionFixture.Run();
            ArrayInitializerExpressionFixture.Run();
            CollectionExpressionFixture.Run();
            CollectionInitializerExpressionFixture.Run();
            ImplicitArrayCreationExpressionFixture.Run();
            IndexExpressionFixture.Run();
            ObjectCreationExpressionFixture.Run();
            OmittedArraySizeExpressionFixture.Run();
            TupleExpressionFixture.Run();
        }
    }
}
