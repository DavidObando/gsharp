// inventory: ExplicitInterfaceSpecifier — explicit interface member implementation (probe)
// Issue #1911: an explicit interface implementation used to lower to a plain
// `private func Greet()` — DeclaredAccessibility for an explicit impl is
// `Private` in Roslyn (it has no accessibility keyword and is unreachable
// through the class type), and the translator mapped that straight through.
// The class type-checked (name match is enough for gsc's binder) but failed
// ilverify: "Class implements interface but not method", because a `private`
// G# method is never wired into the CLR `InterfaceImpl` v-table slot. Fixed:
// an explicit interface implementation now always emits as a plain PUBLIC
// method — G# has no explicit-interface-implementation surface (ADR-0091
// rejected an `IFoo.M(this)` spelling as conflating extension-function sugar
// with explicit interface dispatch), so the public method is the only slot
// available to satisfy the contract.
//
// The other half of the issue — an explicit impl COEXISTING with a same-name
// public method (e.g. `public string Greet()` plus `string IGreeter.Greet()`)
// — cannot be represented with output parity at all: C# gives the two
// methods genuinely different bodies reachable from different static types,
// while G# has only one name-matching slot. That shape is intentionally not
// part of this stdout-parity fixture (see
// Cs2Gs.Tests/Issue1911ExplicitInterfaceImplementationTests.cs for the
// compile/ilverify-clean, no-duplicate-overload coverage of that case).
using System;

namespace Corpus.Grid06
{
    public interface IGreeter
    {
        string Greet();
    }

    public class QuietHost : IGreeter
    {
        string IGreeter.Greet()
        {
            return "hello-explicit";
        }
    }

    public static class ExplicitInterfaceSpecifierFixture
    {
        public static void Run()
        {
            QuietHost host = new QuietHost();
            IGreeter viaInterface = host;
            Console.WriteLine("ExplicitInterfaceSpecifier: interface=" + viaInterface.Greet());
        }
    }
}
