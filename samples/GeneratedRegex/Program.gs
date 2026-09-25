package GeneratedRegex

import GeneratedRegex.Text
import System

Console.WriteLine("month: " + Patterns.Month("2024-05"))
Console.WriteLine("no month: " + Patterns.Month("May 2024"))
Console.WriteLine("tail: " + Patterns.Tail("abc12345"))
Console.WriteLine("no tail: " + Patterns.Tail("abc12"))
Console.WriteLine("first number: " + Patterns.FirstNumber("abc 42 7"))
Console.WriteLine("words: " + Words.Count("one two  three").ToString())
Console.WriteLine("utilities: " + Utilities.Describe())
Console.WriteLine("implementation: " + Patterns.Implementation())
