// file: VariadicDelegate.gs
// ADR-0102 / issue #812 — variadic parameters on a named-delegate
// declaration. The delegate's Invoke method gets [ParamArrayAttribute]
// stamped on its trailing parameter, and direct-call (`del(args)`)
// + explicit `.Invoke(args)` both pack / pass-through.

package GSharp.Example.VariadicDelegate

import System

type StringJoiner = delegate func(sep string, parts ...string) string

var sj StringJoiner = func(sep string, parts ...string) string {
    var s = ""
    for var i = 0; i < parts.Length; i++ {
        if i > 0 { s = s + sep }
        s = s + parts[i]
    }
    return s
}

// Direct-call form: trailing positional args pack into a fresh []string.
Console.WriteLine(sj("-", "p", "q", "r"))

// Direct-call form: a single trailing []string passes through unchanged.
Console.WriteLine(sj("-", []string{"a", "b"}))

// Empty pack — the body sees an empty slice.
Console.WriteLine(sj("-"))

// .Invoke spelling behaves identically.
Console.WriteLine(sj.Invoke("-", "x", "y"))
Console.WriteLine(sj.Invoke("-", []string{"m", "n"}))
Console.WriteLine(sj.Invoke("-"))
