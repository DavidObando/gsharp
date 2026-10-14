// inventory: ExplicitInterfaceSpecifier — explicit interface member implementation (probe)
// Issue #1911: an explicit interface implementation used to lower to a plain
// `private func Greet()` — DeclaredAccessibility for an explicit impl is
// `Private` in Roslyn (it has no accessibility keyword and is unreachable
// through the class type), and the translator mapped that straight through.
// The class type-checked (name match is enough for gsc's binder) but failed
// ilverify: "Class implements interface but not method", because a `private`
// G# method is never wired into the CLR `InterfaceImpl` v-table slot.
//
// Issue #2010 (full fix, follow-up to #1911's "force public" workaround):
// an explicit interface implementation now emits under a reserved mangled
// name (`__explicit_<Interface>__<Member>`) that gsc's binder recognizes and
// links to the specific interface member it implements; the emitter binds a
// CLR `MethodImpl` row (reusing the ADR-0089 static-virtual / issue #985
// bridge machinery) so the interface's slot dispatches to this method's own
// body regardless of its (now C#-faithful, non-public) visibility. This also
// removes the #1911 "coexisting/colliding explicit impls collapse to one
// surviving body" gap entirely: QuietHost below implements the SAME-NAME,
// SAME-SIGNATURE `Greet()` member explicitly for TWO different interfaces
// (IGreeter and IWelcomer) with two DISTINCT bodies, and both dispatch
// correctly — no drop, no diagnostic, full fidelity.

package Corpus.Grid06

import System

interface IGreeter {
    func Greet() string;
}

interface IWelcomer {
    func Greet() string;
}

open class QuietHost : IGreeter, IWelcomer {
    private func (IGreeter) Greet() string {
        return "hello-explicit"
    }

    private func (IWelcomer) Greet() string {
        return "welcome-explicit"
    }
}

shared class ExplicitInterfaceSpecifierFixture {
    func Run() {
        let host = QuietHost()
        let viaGreeter IGreeter = host
        let viaWelcomer IWelcomer = host
        Console.WriteLine("ExplicitInterfaceSpecifier: interface=" + viaGreeter.Greet())
        Console.WriteLine("ExplicitInterfaceSpecifier: collision=" + viaGreeter.Greet() + "/" + viaWelcomer.Greet())
    }
}
