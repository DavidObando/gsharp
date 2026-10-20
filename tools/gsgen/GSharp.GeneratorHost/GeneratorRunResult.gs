// <copyright file="GeneratorRunResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic

/// The aggregate outcome of running Roslyn source generators against the C#
/// stub projection (ADR-0145 §C): the generated documents, the diagnostics the
/// generators reported, and any crash-isolated failures.
class GeneratorRunResult {
    /// Initializes a new instance of the (cref:GeneratorRunResult) class.
    /// @param documents The generated C# documents.
    /// @param generatorDiagnostics The diagnostics reported by the generators.
    /// @param failures Generators that threw or analyzer assemblies that failed to load.
    /// @param inputStubTree The immutable generator input tree reused for back-translation, or none.
    init(
        documents IReadOnlyList[GeneratedCsDocument],
        generatorDiagnostics IReadOnlyList[Diagnostic],
        failures IReadOnlyList[GeneratorFailure],
        inputStubTree SyntaxTree? = nil
    ) {
        Documents = documents
        GeneratorDiagnostics = generatorDiagnostics
        Failures = failures
        InputStubTree = inputStubTree
    }

    /// Gets the generated C# documents (hint name + source text).
    prop Documents IReadOnlyList[GeneratedCsDocument] {
        get;
    }

    /// Gets the diagnostics reported by the generators.
    prop GeneratorDiagnostics IReadOnlyList[Diagnostic] {
        get;
    }

    /// Gets the generators that threw or analyzer assemblies that failed to load.
    prop Failures IReadOnlyList[GeneratorFailure] {
        get;
    }

    /// Gets the immutable Roslyn input tree, not a bound scope or final compilation.
    prop InputStubTree SyntaxTree? {
        get;
    }
}

/// One generated C# document produced by a Roslyn source generator: its
/// generator-assigned `hintName` and the emitted (cref:SourceText)
/// (ADR-0145 §C).
class GeneratedCsDocument {
    /// Initializes a new instance of the (cref:GeneratedCsDocument) class.
    /// @param hintName The generator-assigned hint name (e.g. `Foo.g.cs`).
    /// @param sourceText The generated C# source text.
    /// @param syntaxTree The already parsed generator tree, or none for a foreign document.
    init(hintName string, sourceText SourceText, syntaxTree SyntaxTree? = nil) {
        HintName = hintName
        SourceText = sourceText
        SyntaxTree = syntaxTree
    }

    /// Gets the generator-assigned hint name.
    prop HintName string {
        get;
    }

    /// Gets the generated C# source text.
    prop SourceText SourceText {
        get;
    }

    /// Gets the generator's immutable tree when available.
    prop SyntaxTree SyntaxTree? {
        get;
    }
}

/// A generator that threw during execution or an analyzer assembly that failed
/// to load. Recording (rather than propagating) these keeps a single broken
/// generator from aborting the whole host run — ADR-0145 §C crash isolation.
class GeneratorFailure {
    /// Initializes a new instance of the (cref:GeneratorFailure) class.
    /// @param source A description of the failing generator or analyzer path.
    /// @param exception The captured exception.
    init(source string, exception Exception?) {
        Source = source
        Exception = exception
    }

    /// Gets a description of the failing generator or analyzer path.
    prop Source string {
        get;
    }

    /// Gets the captured exception.
    prop Exception Exception? {
        get;
    }
}
