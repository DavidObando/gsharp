// file: IfLetGuardLet.gs
// ADR-0071 / issue #708: demonstrates the `if let` and `guard let`
// bindings that strip the nullable layer from a value and expose the
// underlying type to the body. Each block prints a small, unmistakable
// line so a reviewer can read the golden top-to-bottom and match it
// against the source.

package GSharp.Example.IfLetGuardLet

import System

// 1. `if let` with a single binding: `name` is in scope only inside
// the then-branch and is observed at the underlying (non-null) type.
func Greet(name string?) {
    if let n = name {
        Console.WriteLine("hi $n")
    } else {
        Console.WriteLine("hi stranger")
    }
}

Greet("Alice")
Greet(nil)

// 2. `if let` with multiple comma-separated bindings: all-or-nothing.
// The then-branch runs only when every initializer is non-nil.
func Pair(left string?, right string?) {
    if let a = left, let b = right {
        Console.WriteLine("pair: $a + $b")
    } else {
        Console.WriteLine("pair: missing")
    }
}

Pair("a", "b")
Pair("a", nil)
Pair(nil, "b")

// 3. `guard let` — the binding is in scope for the rest of the
// enclosing block, and the else clause must unconditionally exit.
func Length(s string?) int32 {
    guard let v = s else {
        return -1
    }

    return v.Length
}

Console.WriteLine(Length("abcd"))
Console.WriteLine(Length(nil))

// 4. `guard let` composes with the normal nil-narrowing path. After
// the guard succeeds, subsequent statements see `v` at the underlying
// non-null type without a further check.
func Loud(s string?) {
    guard let v = s else {
        Console.WriteLine("quiet")
        return
    }

    Console.WriteLine(v + "!")
    let n = v.Length
    Console.WriteLine("len=$n")
}

Loud("hi")
Loud(nil)
