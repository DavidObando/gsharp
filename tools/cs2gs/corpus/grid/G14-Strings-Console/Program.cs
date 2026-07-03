// G14-Strings-Console: string-interpolation and formatting constructs,
// one fixture per file, invoked in file-name order. Stdout is the parity oracle.
using System;

namespace Corpus.Grid14
{
    internal static class Program
    {
        private static void Main()
        {
            EscapeSequenceEscFixture.Run();
            EscapeSequencesFixture.Run();
            InterpolatedStringExpressionFixture.Run();
            InterpolatedStringTextFixture.Run();
            InterpolationFixture.Run();
            InterpolationAlignmentClauseFixture.Run();
            InterpolationFormatClauseFixture.Run();
            StringConcatenationFixture.Run();
            StringFormatParityFixture.Run();
        }
    }
}
