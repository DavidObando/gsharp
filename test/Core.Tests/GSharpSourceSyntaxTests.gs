// <copyright file="GSharpSourceSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import Xunit

/// The G# half of the source guards must key diagnostic sites exactly as the C#
/// scan does, or distinct sites collapse into one shape after the cut-over and
/// a duplicated diagnostic message shape passes DiagnosticIdUniquenessTests.
open class GSharpSourceSyntaxTests {
    /// Two constructors in different types and a property's get and set each
    /// keep their own key, matching the C# scan (type name for constructors,
    /// `Property.get`/`Property.set` for accessors).
    @Fact
    func NearestMemberName_KeepsConstructorsAndAccessorsDistinct() {
        let path = Path.Combine(
            AppContext.BaseDirectory,
            "gsharp-source-syntax-" + Guid.NewGuid().ToString("N") + ".gs"
        )
        File.WriteAllText(path, Source)
        try {
            let tree = SyntaxTree.Parse(SourceText.From(Source, path))
            let keys = tree
                .Root
                .DescendantNodes()
                .OfType[CallExpressionSyntax]()
                .Where((call CallExpressionSyntax) -> GSharpSourceSyntax.SimpleName(call) == "Diagnostic")
                .Select(GSharpSourceSyntax.NearestMemberName)
                .OrderBy((key string) -> key, StringComparer.Ordinal)
                .ToArray()
            Assert.Equal([]string{"First", "Make", "Second", "Value.get", "Value.set"}, keys)
        } finally {
            File.Delete(path)
        }
    }

    shared {
        private const Source string = `package Shapes

class First {
    init() {
        let d = Diagnostic(nil, "GS0001", 1)
    }
}

class Second {
    init() {
        let d = Diagnostic(nil, "GS0001", 2)
    }

    prop Value int32 {
        get {
            let d = Diagnostic(nil, "GS0001", 3)
            return 0
        }
        set {
            let d = Diagnostic(nil, "GS0001", 4)
        }
    }

    func Make() {
        let d = Diagnostic(nil, "GS0001", 5)
    }
}`
    }
}
