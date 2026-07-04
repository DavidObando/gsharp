// G07-Members-Console: member-declaration construct grid for cs2gs differential
// conformance (ADR-0115). One construct per file under Constructs/; each
// fixture prints deterministic lines prefixed "<Kind>: ". Run order is
// Constructs/ file-name (ordinal) order.
using System;

namespace Corpus.Grid07
{
    internal static class Program
    {
        private static void Main()
        {
            ArrowExpressionClauseFixture.Run();
            AttributeListFixture.Run();
            BaseConstructorInitializerFixture.Run();

            // CompoundAssignmentOperatorDeclarationFixture (issue #1908): the C#14
            // instance `operator +=` declaration is a recorded/tracked CS2GS-GAP —
            // it has no canonical G# form (ADR-0035), so the translate stage for
            // this app fails by design and is tolerated via tools/cs2gs/triage/gaps.json.
            CompoundAssignmentOperatorDeclarationFixture.Run();

            ConstructorDeclarationFixture.Run();
            ConversionOperatorDeclarationFixture.Run();
            EventDeclarationFixture.Run();
            EventFieldDeclarationFixture.Run();
            FieldDeclarationFixture.Run();
            FieldExpressionFixture.Run();
            IndexerDeclarationFixture.Run();
            InitAccessorDeclarationFixture.Run();
            MethodDeclarationFixture.Run();
            OperatorDeclarationFixture.Run();
            PropertyDeclarationFixture.Run();
            ThisConstructorInitializerFixture.Run();
        }
    }
}
