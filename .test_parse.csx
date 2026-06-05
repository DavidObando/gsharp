#r "out/bin/Debug/Core/GSharp.Core.dll"
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

var src = @"package OutVar
import System

func produce(out value int32) {
    value = 7
}

produce(out var x)
System.Console.WriteLine(x)
";
var tree = SyntaxTree.Parse(SourceText.From(src));
System.Console.WriteLine("=== parse diags ===");
foreach (var d in tree.Diagnostics) System.Console.WriteLine($"  {d}");
System.Console.WriteLine("=== root tree ===");
System.Console.WriteLine(tree.Root.ToString());
