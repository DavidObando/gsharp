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

package Corpus.Grid04.Constructs

import System

internal data class RpAddress(City string, Zip int32) : IEquatable[RpAddress] { }

internal data class RpPerson(Name string, Address RpAddress) : IEquatable[RpPerson] { }

shared class RecursivePatternFixture {
    func Run() {
        let person RpPerson? = RpPerson("Ada", RpAddress("Lima", 15001))
        let inLima = person != nil && person.Address.City == "Lima"
        Console.WriteLine("RecursivePattern: person is in Lima = $inLima")
        if person != nil && (person.Address.Zip > 15000 && person.Address.Zip < 16000) {
            Console.WriteLine("RecursivePattern: person has a Lima-range zip")
        }
        let shortName = person != nil && person.Name.Length == 3
        Console.WriteLine("RecursivePattern: name length 3 = $shortName")
        if person is {Address: var addr} {
            Console.WriteLine("RecursivePattern: nested var binds address city = ${addr.City}")
        }
        let router = RpPerson("Bea", RpAddress("Cusco", 8000))
        let route = switch router {
            case {Name: "Ada"}: "ada route"
            case {Address: var routedAddr}: "routed via ${routedAddr.City}"
            default: "other route"
        }
        Console.WriteLine("RecursivePattern: routed to $route")
        // Issue #1923: nested property pattern over a non-nullable
        // reference member.
        let nestedInLima = person != nil && person.Address.City == "Lima"
        Console.WriteLine("RecursivePattern: nested property pattern = $nestedInLima")
        // Issue #1923: switch-expression property pattern over a nullable
        // subject.
        let classify = switch person {
            case {Name: "Ada"}: "ada"
            case nil: "none"
            default: "other"
        }
        Console.WriteLine("RecursivePattern: classify = $classify")
        // Issue #1923: recursive pattern on a boxed subject.
        let boxedMatch = (object?(person) is RpPerson and {Name: "Ada"})
        Console.WriteLine("RecursivePattern: boxed match = $boxedMatch")
    }
}
