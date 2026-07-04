// inventory: RecursivePattern
// NOTE: quarantined sub-cases (all fail after a clean stage-1 translation):
//   * NESTED property patterns over a reference member, e.g.
//     `person is { Address: { City: "Lima" } }`: the lowering emits
//     `person.Address != nil && person.Address.City == ...`. With a
//     non-nullable member gsc rejects the nil check (GS0129: '!=' undefined
//     for 'RpAddress'/'nil'); with a nullable member gsc does not flow-narrow
//     the property chain, so the member access fails (GS0158: cannot find
//     member City/Zip on 'RpAddress?').
//   * switch-expression property patterns over a NULLABLE subject — GS0172
//     ("Property pattern requires a struct or class value, not 'RpPerson?'").
//   * recursive pattern on a boxed subject (`(object?)p is RpPerson {...}`) —
//     lowered without a cast: GS0155 ("Cannot convert type 'RpPerson?' to
//     'object'") then GS0158 ("Cannot find member Name") on the spill local.
// Kept: top-level property patterns on a nullable subject (constant,
// relational, and extended `A.B:` sub-patterns), a `{ Prop: var v }` binder
// sub-pattern (issue #1888, resolved), and shallow property-pattern arms in a
// switch expression over a non-nullable subject.
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
        }
    }
}

