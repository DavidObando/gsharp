package ForeignCompile

import System

// ADR-0145 §C extension (issue #2214): ThisAssembly.cs above is a stray C#
// Compile item (standing in for Nerdbank.GitVersioning's generated file). The
// Gsharp.NET.Sdk translates it to G# via gsgen before gsc runs, so its
// constants resolve here exactly like any other G# type in this package.
Console.WriteLine(ThisAssembly.AssemblyFileVersion)
