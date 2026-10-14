// <copyright file="FoldingComputerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Collections.Generic
import System.Linq
import Xunit

open class FoldingComputerTests {
    @Fact
    func ComputeFoldings_ReturnsRange_PerFunction() {
        const source = "package P\n" + "\n" + "func A() {\n" + "}\n" + "\n" + "func B() {\n" + "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lineBreaks = List[int32]()
        for var i = 0; i < source.Length; i++ {
            if source[i] == '\n' {
                lineBreaks.Add(i)
            }
        }
        let content = DocumentContent(tree, lineBreaks)
        let foldings = FoldingComputer.ComputeFoldings(content).ToList()
        Assert.Equal(2, foldings.Count)
        Assert.All(foldings, (f FoldingRange) -> Assert.True(f.EndLine >= f.StartLine))
    }

    @Fact
    func ComputeFoldings_NoFunctions_ReturnsEmpty() {
        let tree = SyntaxTree.Parse("package P\n")
        let content = DocumentContent(tree, []int32{9})
        Assert.Empty(FoldingComputer.ComputeFoldings(content))
    }

    @Fact
    func ComputeFoldings_ClassMethods_FoldTypeAndEachBody() {
        const source = "package P\n" +
            "\n" +
            "class Service {\n" +
            "    func Start() {\n" +
            "    }\n" +
            "    func Stop() {\n" +
            "    }\n" +
            "}\n" // 7
        let folds = Fold(source)
        // The class itself and both method bodies fold; ordered by start line.
        Assert.Equal([](int32, int32){(2, 7), (3, 4), (5, 6)}, folds)
    }

    @Fact
    func ComputeFoldings_StructMethods_FoldTypeAndBody() {
        const source = "package P\n" +
            "\n" +
            "struct Point {\n" +
            "    func Norm() int32 {\n" +
            "        return 0\n" +
            "    }\n" +
            "}\n" // 6
        let folds = Fold(source)
        Assert.Equal([](int32, int32){(2, 6), (3, 5)}, folds)
    }

    @Fact
    func ComputeFoldings_ConstructorBody_Folds() {
        const source = "package P\n" + "\n" + "class C {\n" + "    init() {\n" + "    }\n" + "}\n" // 5
        let folds = Fold(source)
        Assert.Equal([](int32, int32){(2, 5), (3, 4)}, folds)
    }

    @Fact
    func ComputeFoldings_PropertyWithAccessorBody_FoldsTypePropertyAndAccessor() {
        const source = "package P\n" +
            "\n" +
            "class Counter {\n" +
            "    var n int32\n" +
            "    prop Doubled int32 {\n" +
            "        get {\n" +
            "            return n\n" +
            "        }\n" +
            "    }\n" +
            "}\n" // 9
        let folds = Fold(source)
        // The type, the property brace region, and the get accessor body all fold.
        Assert.Equal([](int32, int32){(2, 9), (4, 8), (5, 7)}, folds)
    }

    @Fact
    func ComputeFoldings_ForBlockInsideMethod_Folds() {
        const source = "package P\n" + "\n" + "func main() {\n" + "    for i in 0..10 {\n" + "    }\n" + "}\n" // 5
        let folds = Fold(source)
        Assert.Equal([](int32, int32){(2, 5), (3, 4)}, folds)
    }

    @Fact
    func ComputeFoldings_DeepNesting_BlockInMethodInClass() {
        const source = "package P\n" +
            "\n" +
            "class C {\n" +
            "    func M() {\n" +
            "        if true {\n" +
            "        }\n" +
            "    }\n" +
            "}\n" // 7
        let folds = Fold(source)
        // class -> method body -> if-block, each folds independently.
        Assert.Equal([](int32, int32){(2, 7), (3, 6), (4, 5)}, folds)
    }

    @Fact
    func ComputeFoldings_TryCatchFinally_FoldsEachBlock() {
        const source = "package P\n" +
            "\n" +
            "func main() {\n" +
            "    try {\n" +
            "    } catch (e error) {\n" +
            "    } finally {\n" +
            "    }\n" +
            "}\n" // 7
        let folds = Fold(source)
        // main body plus the try, catch, and finally blocks.
        Assert.Equal([](int32, int32){(2, 7), (3, 4), (4, 5), (5, 6)}, folds)
    }

    @Fact
    func ComputeFoldings_SwitchStatement_Folds() {
        const source = "package P\n" +
            "\n" +
            "func main() {\n" +
            "    var n = 0\n" +
            "    switch n {\n" +
            "        default { }\n" +
            "    }\n" +
            "}\n" // 7
        let folds = Fold(source)
        // main body and the switch block (the single-line default case does not fold).
        Assert.Equal([](int32, int32){(2, 7), (4, 6)}, folds)
    }

    @Fact
    func ComputeFoldings_SingleLineBlock_DoesNotFold() {
        const source = "package P\n" + "\n" + "func A() { }\n" // 2 (open and close brace share a line)
        Assert.Empty(Fold(source))
    }

    @Fact
    func ComputeFoldings_Interface_Folds() {
        const source = "package P\n" +
            "\n" +
            "interface IShape {\n" +
            "    func Area() int32;\n" +
            "    func Name() string;\n" +
            "}\n" // 5
        let folds = Fold(source)
        // The interface declaration folds; its bodiless method stubs do not.
        Assert.Equal([](int32, int32){(2, 5)}, folds)
    }

    @Fact
    func ComputeFoldings_Enum_Folds() {
        const source = "package P\n" + "\n" + "enum Color {\n" + "    Red,\n" + "    Green\n" + "}\n" // 5
        let folds = Fold(source)
        Assert.Equal([](int32, int32){(2, 5)}, folds)
    }

    shared {
        private func Fold(source string)[](StartLine int32, EndLine int32) {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let content = LanguageServerTestHelpers.Content(source)
            return FoldingComputer
                .ComputeFoldings(content)
                .Select((f FoldingRange) -> (f.StartLine, f.EndLine))
                .ToArray()
        }
    }
}
