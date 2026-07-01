// <copyright file="FoldingComputerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class FoldingComputerTests
{
    [Fact]
    public void ComputeFoldings_ReturnsRange_PerFunction()
    {
        const string source =
            "package P\n" +
            "\n" +
            "func A() {\n" +
            "}\n" +
            "\n" +
            "func B() {\n" +
            "}\n";

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lineBreaks = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lineBreaks.Add(i);
            }
        }

        var content = new DocumentContent(tree, lineBreaks);
        var foldings = FoldingComputer.ComputeFoldings(content).ToList();
        Assert.Equal(2, foldings.Count);
        Assert.All(foldings, f => Assert.True(f.EndLine >= f.StartLine));
    }

    [Fact]
    public void ComputeFoldings_NoFunctions_ReturnsEmpty()
    {
        var tree = SyntaxTree.Parse("package P\n");
        var content = new DocumentContent(tree, [9]);
        Assert.Empty(FoldingComputer.ComputeFoldings(content));
    }

    [Fact]
    public void ComputeFoldings_ClassMethods_FoldTypeAndEachBody()
    {
        const string source =
            "package P\n" +              // 0
            "\n" +                        // 1
            "class Service {\n" +         // 2
            "    func Start() {\n" +      // 3
            "    }\n" +                   // 4
            "    func Stop() {\n" +       // 5
            "    }\n" +                   // 6
            "}\n";                        // 7

        var folds = Fold(source);

        // The class itself and both method bodies fold; ordered by start line.
        Assert.Equal(new[] { (2, 7), (3, 4), (5, 6) }, folds);
    }

    [Fact]
    public void ComputeFoldings_StructMethods_FoldTypeAndBody()
    {
        const string source =
            "package P\n" +              // 0
            "\n" +                        // 1
            "struct Point {\n" +          // 2
            "    func Norm() int32 {\n" + // 3
            "        return 0\n" +        // 4
            "    }\n" +                   // 5
            "}\n";                        // 6

        var folds = Fold(source);

        Assert.Equal(new[] { (2, 6), (3, 5) }, folds);
    }

    [Fact]
    public void ComputeFoldings_ConstructorBody_Folds()
    {
        const string source =
            "package P\n" +      // 0
            "\n" +                // 1
            "class C {\n" +       // 2
            "    init() {\n" +    // 3
            "    }\n" +           // 4
            "}\n";                // 5

        var folds = Fold(source);

        Assert.Equal(new[] { (2, 5), (3, 4) }, folds);
    }

    [Fact]
    public void ComputeFoldings_PropertyWithAccessorBody_FoldsTypePropertyAndAccessor()
    {
        const string source =
            "package P\n" +                  // 0
            "\n" +                            // 1
            "class Counter {\n" +             // 2
            "    var n int32\n" +             // 3
            "    prop Doubled int32 {\n" +    // 4
            "        get {\n" +               // 5
            "            return n\n" +        // 6
            "        }\n" +                   // 7
            "    }\n" +                       // 8
            "}\n";                            // 9

        var folds = Fold(source);

        // The type, the property brace region, and the get accessor body all fold.
        Assert.Equal(new[] { (2, 9), (4, 8), (5, 7) }, folds);
    }

    [Fact]
    public void ComputeFoldings_ForBlockInsideMethod_Folds()
    {
        const string source =
            "package P\n" +               // 0
            "\n" +                         // 1
            "func main() {\n" +           // 2
            "    for i in 0..10 {\n" +    // 3
            "    }\n" +                   // 4
            "}\n";                        // 5

        var folds = Fold(source);

        Assert.Equal(new[] { (2, 5), (3, 4) }, folds);
    }

    [Fact]
    public void ComputeFoldings_DeepNesting_BlockInMethodInClass()
    {
        const string source =
            "package P\n" +          // 0
            "\n" +                    // 1
            "class C {\n" +          // 2
            "    func M() {\n" +     // 3
            "        if true {\n" +  // 4
            "        }\n" +          // 5
            "    }\n" +              // 6
            "}\n";                    // 7

        var folds = Fold(source);

        // class -> method body -> if-block, each folds independently.
        Assert.Equal(new[] { (2, 7), (3, 6), (4, 5) }, folds);
    }

    [Fact]
    public void ComputeFoldings_TryCatchFinally_FoldsEachBlock()
    {
        const string source =
            "package P\n" +               // 0
            "\n" +                         // 1
            "func main() {\n" +           // 2
            "    try {\n" +               // 3
            "    } catch (e error) {\n" + // 4
            "    } finally {\n" +         // 5
            "    }\n" +                   // 6
            "}\n";                        // 7

        var folds = Fold(source);

        // main body plus the try, catch, and finally blocks.
        Assert.Equal(new[] { (2, 7), (3, 4), (4, 5), (5, 6) }, folds);
    }

    [Fact]
    public void ComputeFoldings_SwitchStatement_Folds()
    {
        const string source =
            "package P\n" +                    // 0
            "\n" +                              // 1
            "func main() {\n" +                // 2
            "    var n = 0\n" +                // 3
            "    switch n {\n" +               // 4
            "        default { }\n" +          // 5
            "    }\n" +                        // 6
            "}\n";                              // 7

        var folds = Fold(source);

        // main body and the switch block (the single-line default case does not fold).
        Assert.Equal(new[] { (2, 7), (4, 6) }, folds);
    }

    [Fact]
    public void ComputeFoldings_SingleLineBlock_DoesNotFold()
    {
        const string source =
            "package P\n" +      // 0
            "\n" +                // 1
            "func A() { }\n";     // 2 (open and close brace share a line)

        Assert.Empty(Fold(source));
    }

    [Fact]
    public void ComputeFoldings_Interface_Folds()
    {
        const string source =
            "package P\n" +                // 0
            "\n" +                          // 1
            "interface IShape {\n" +       // 2
            "    func Area() int32;\n" +   // 3
            "    func Name() string;\n" +  // 4
            "}\n";                          // 5

        var folds = Fold(source);

        // The interface declaration folds; its bodiless method stubs do not.
        Assert.Equal(new[] { (2, 5) }, folds);
    }

    [Fact]
    public void ComputeFoldings_Enum_Folds()
    {
        const string source =
            "package P\n" +      // 0
            "\n" +                // 1
            "enum Color {\n" +   // 2
            "    Red,\n" +       // 3
            "    Green\n" +      // 4
            "}\n";                // 5

        var folds = Fold(source);

        Assert.Equal(new[] { (2, 5) }, folds);
    }

    private static (int StartLine, int EndLine)[] Fold(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var content = LanguageServerTestHelpers.Content(source);
        return FoldingComputer.ComputeFoldings(content)
            .Select(f => (f.StartLine, f.EndLine))
            .ToArray();
    }
}
