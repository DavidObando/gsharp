using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

class P {
    static void Main() {
        var src = @"package OutVar
import System

func produce(out value int32) {
    value = 7
}

produce(out var x)
Console.WriteLine(x)
";
        var tree = SyntaxTree.Parse(SourceText.From(src));
        Console.WriteLine("Diagnostics: " + tree.Diagnostics.Count());
        foreach (var d in tree.Diagnostics) Console.WriteLine("  " + d.Message);
        var c = new Compilation(tree);
        using var s = new MemoryStream();
        var r = c.Emit(s);
        foreach (var d in r.Diagnostics) Console.WriteLine(d.Message);
    }
}
