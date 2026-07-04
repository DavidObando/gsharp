// inventory: RecursivePattern
// Issue #1923 (all fixed, no longer quarantined):
//   * NESTED property patterns over a reference member, e.g.
//     `person is { Address: { City: "Lima" } }`: the translator unconditionally
//     emitted `person.Address != nil && person.Address.City == ...`, which gsc
//     rejected for a non-nullable member (GS0129: '!=' undefined for
//     'RpAddress'/'nil'). Fixed by teaching the translator's nested
//     recursive-pattern lowering to skip the null check when the member's
//     declared C# type is a non-nullable reference (`RpAddress`, not
//     `RpAddress?`) — that shape can never be null under G#'s stricter null
//     model, so no check is needed (or legal).
//   * switch-expression property patterns over a NULLABLE subject — used to
//     fail with GS0172 ("Property pattern requires a struct or class value,
//     not 'RpPerson?'"). Fixed by having gsc's property-pattern binder/emitter
//     unwrap a nullable-of-reference-class discriminant (with a null guard) so
//     the pattern binds against the underlying class.
//   * recursive pattern on a boxed subject (`(object?)p is RpPerson {...}`) —
//     used to lower to a spill (`let __spill0 = object(person)`) that failed
//     with GS0155 then GS0158. Resolved by the same nullable-discriminant
//     fixes above plus the boxed-constant-equality fix (issue #1923 sub-bug 1).
// Kept quarantined: none — all previously-quarantined sub-cases above are now
// covered below alongside the pre-existing (already working) top-level
// property patterns on a nullable subject (constant, relational, and extended
// `A.B:` sub-patterns), the `{ Prop: var v }` binder sub-pattern (issue #1888),
// and shallow property-pattern arms in a switch expression over a non-nullable
// subject.
using System;

namespace Corpus.Grid04.Constructs
{
    internal sealed record RpAddress(string City, int Zip);

    internal sealed record RpPerson(string Name, RpAddress Address);

    public static class RecursivePatternFixture
    {
        public static void Run()
        {
            RpPerson? person = new RpPerson("Ada", new RpAddress("Lima", 15001));

            bool inLima = person is { Address.City: "Lima" };
            Console.WriteLine($"RecursivePattern: person is in Lima = {inLima}");

            if (person is { Address.Zip: > 15000 and < 16000 })
            {
                Console.WriteLine("RecursivePattern: person has a Lima-range zip");
            }

            bool shortName = person is { Name.Length: 3 };
            Console.WriteLine($"RecursivePattern: name length 3 = {shortName}");

            if (person is { Address: var addr })
            {
                Console.WriteLine($"RecursivePattern: nested var binds address city = {addr.City}");
            }

            RpPerson router = new RpPerson("Bea", new RpAddress("Cusco", 8000));
            string route = router switch
            {
                { Name: "Ada" } => "ada route",
                { Address: var routedAddr } => $"routed via {routedAddr.City}",
                _ => "other route",
            };
            Console.WriteLine($"RecursivePattern: routed to {route}");

            // Issue #1923: nested property pattern over a non-nullable
            // reference member.
            bool nestedInLima = person is { Address: { City: "Lima" } };
            Console.WriteLine($"RecursivePattern: nested property pattern = {nestedInLima}");

            // Issue #1923: switch-expression property pattern over a nullable
            // subject.
            string classify = person switch
            {
                { Name: "Ada" } => "ada",
                null => "none",
                _ => "other",
            };
            Console.WriteLine($"RecursivePattern: classify = {classify}");

            // Issue #1923: recursive pattern on a boxed subject.
            bool boxedMatch = (object?)person is RpPerson { Name: "Ada" };
            Console.WriteLine($"RecursivePattern: boxed match = {boxedMatch}");
        }
    }
}

