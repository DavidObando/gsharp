// file: InterpolatedStringRichHoles.gs
// ADR-0055 §A conformance fixture: the delimiter-aware hole scanner. Covers a
// nested string literal inside a hole, a nested string whose `,`/`:` must not
// be read as alignment/format clauses, a method call on the nested string, and
// a multiline hole that spans a newline.

package InterpolatedStringRichHoles

let n = 6

// Nested string literal in a hole.
Console.WriteLine("greeting=${"hello"}")

// `,` and `:` live inside the nested string, not as clause delimiters.
Console.WriteLine("len=${"a,b:c".Length}")

// Multiline hole (C# 11 parity): the expression spans a newline.
Console.WriteLine("answer=${n *
7}")
