// inventory: AnonymousMethodExpression

package Corpus.Grid09

import System

internal delegate CollisionHandler(obj string, generated int32, init bool);

internal delegate RefAnonymousMethodHandler(ref value int32) int32;

internal delegate InAnonymousMethodHandler(in value int32) int32;

internal delegate VariadicAnonymousMethodHandler(values ...int32) int32;

shared class AnonymousMethodExpressionFixture {
    func Run() {
        let inc(int32) -> int32 = (x int32) -> {
            return x + 1
        }
        Console.WriteLine("AnonymousMethodExpression: inc(41)=${inc(41)}")
        // Parameterless anonymous method (no parameter list at all).
        let answer() -> int32 = () -> {
            return 42
        }
        Console.WriteLine("AnonymousMethodExpression: answer=${answer()}")
        // Parameterless anonymous method targeting a zero-arg delegate type.
        let greet() -> void = () -> {
            Console.WriteLine("AnonymousMethodExpression: greet=hi")
        }
        greet()
        let shout(string) -> void = (s string) -> {
            Console.WriteLine("AnonymousMethodExpression: shout $s!")
        }
        shout("hey")
        // Parameterless anonymous method targeting Action<string>: the
        // synthesized param must NOT reuse Invoke's declared param name
        // ("obj"), else it silently shadows the captured outer "obj"
        // local below and the call argument leaks into the body instead.
        let obj = "captured"
        let shoutObj(string) -> void = (_ string) -> {
            Console.WriteLine("AnonymousMethodExpression: shoutObj=$obj")
        }
        shoutObj("ignored")
        // Driver coverage: the inferred slots become repeatable G# `_`
        // parameters that bind, compile, and run. Focused unit tests
        // discriminate collision and shadowing behavior.
        let generated = 42
        let init = true
        let collisions CollisionHandler = (_ string, _ int32, _ bool) -> {
            Console.WriteLine("AnonymousMethodExpression: collisions=$obj/$generated/$init")
        }
        collisions("ignored", 0, false)
        // C# permits omitted anonymous-method parameter lists for ref, in,
        // and params-array delegate slots. The body cannot name any slot.
        let byRef RefAnonymousMethodHandler = (ref _ int32) -> {
            return generated
        }
        let readOnly InAnonymousMethodHandler = (in _ int32) -> {
            return generated + 1
        }
        let variadic VariadicAnonymousMethodHandler = (_ ...int32) -> {
            return generated + 2
        }
        var value = 5
        Console.WriteLine(
            "AnonymousMethodExpression: modifiers=${byRef(&value)}/${readOnly(in value)}/${variadic(1, 2, 3)}/$value"
        )
    }
}
