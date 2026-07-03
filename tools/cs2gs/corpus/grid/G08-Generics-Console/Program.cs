// G08-Generics-Console: generics construct grid for cs2gs differential
// conformance (ADR-0115). One construct per file under Constructs/; each
// fixture prints deterministic lines prefixed "<Kind>: ". Run order is
// Constructs/ file-name (ordinal) order.
using System;

namespace Corpus.Grid08
{
    internal static class Program
    {
        private static void Main()
        {
            AllowsConstraintClauseFixture.Run();
            ClassConstraintFixture.Run();
            ConstructorConstraintFixture.Run();

            // QUARANTINED (see Quarantined/): DefaultConstraintFixture — the abstract
            // generic method with T? that `where T : default` requires trips gsc
            // issue #987 (GS0387/GS0386 abstract member not implemented, GS0185
            // override mismatch on `value T?`, GS0151 inference).

            // QUARANTINED (see Quarantined/): GenericAttributeFixture — C#11 generic
            // attribute application `[Tag<int>]` emits `@Tag<int>` which does not
            // round-trip-parse (CS2GS-ROUNDTRIP: GS0005 Unexpected token <LessToken>);
            // user attribute classes are also rejected by gsc (GS0200, see G07).
            GenericNameFixture.Run();
            OmittedTypeArgumentFixture.Run();
            StructConstraintFixture.Run();
            TypeArgumentListFixture.Run();
            TypeConstraintFixture.Run();

            // QUARANTINED (see Quarantined/): TypeParameterFixture — declaration-site
            // variance is not honored: assigning ISource<string> to ISource<object>
            // fails compile (GS0155 Cannot convert 'ISource[string]' to
            // 'ISource[object]'); also GS0129 'string' + 'string?' on T.ToString().
            TypeParameterListFixture.Run();
        }
    }
}
