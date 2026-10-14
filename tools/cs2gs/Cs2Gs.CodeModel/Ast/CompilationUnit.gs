// <copyright file="CompilationUnit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic

/// A G# compilation unit: an optional package declaration, an import block, and
/// ordered top-level members/statements (ADR-0115 §B.1). This is the root node
/// the canonical pretty-printer consumes.
class CompilationUnit : GNode {
    /// Initializes a new instance of the (cref:CompilationUnit) class.
    /// @param package The package name, or `null` for none.
    /// @param imports The import directives, in original order.
    /// @param members The ordered top-level members and statements.
    /// @param leadingComments Optional file-leading comment lines, printed as given before the package
    /// declaration. Each line includes its comment markers; the translator
    /// supplies them with trailing whitespace trimmed and no line endings: it
    /// splits the header with Roslyn's own line model, so every C# line
    /// terminator ends a line.
    /// @param fileAttributes Assembly- or module-targeted file-level attributes, in source order.
    init(
        $package string? = nil,
        imports IReadOnlyList[ImportDirective]? = nil,
        members IReadOnlyList[GNode]? = nil,
        leadingComments IReadOnlyList[string]? = nil,
        fileAttributes IReadOnlyList[AttributeUse]? = nil
    ) {
        Package = $package
        Imports = imports ?? List[ImportDirective]()
        Members = members ?? List[GNode]()
        LeadingComments = leadingComments ?? List[string]()
        FileAttributes = fileAttributes ?? List[AttributeUse]()
    }

    /// Gets the package name, or `null` for none.
    prop Package string? {
        get;
    }

    /// Gets the import directives, in original order.
    prop Imports IReadOnlyList[ImportDirective] {
        get;
    }

    /// Gets the ordered top-level members and statements.
    prop Members IReadOnlyList[GNode] {
        get;
    }

    /// Gets the file-leading comment lines, printed as given, including their comment markers.
    prop LeadingComments IReadOnlyList[string] {
        get;
    }

    /// Gets assembly- or module-targeted file-level attributes.
    prop FileAttributes IReadOnlyList[AttributeUse] {
        get;
    }
}

/// An `import X.Y` directive, optionally aliased (`import A = X.Y`)
/// (ADR-0115 §B.1).
class ImportDirective : GNode {
    /// Initializes a new instance of the (cref:ImportDirective) class.
    /// @param name The imported dotted name.
    /// @param alias The optional alias.
    init(name string, alias string? = nil) {
        Name = name
        Alias = alias
    }

    /// Gets the imported dotted name.
    prop Name string {
        get;
    }

    /// Gets the optional alias.
    prop Alias string? {
        get;
    }
}
