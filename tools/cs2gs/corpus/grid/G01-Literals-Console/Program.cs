// G01-Literals-Console: literal-expression constructs, one fixture per file,
// invoked in file-name order. Stdout is the parity oracle.
using System;

namespace Corpus.Grid01
{
    internal static class Program
    {
        private static void Main()
        {
            CharacterLiteralExpressionFixture.Run();
            DefaultLiteralExpressionFixture.Run();
            FalseLiteralExpressionFixture.Run();
            NullLiteralExpressionFixture.Run();
            NumericLiteralExpressionFixture.Run();
            StringLiteralExpressionFixture.Run();
            TrueLiteralExpressionFixture.Run();
            Utf8StringLiteralExpressionFixture.Run();
        }
    }
}
