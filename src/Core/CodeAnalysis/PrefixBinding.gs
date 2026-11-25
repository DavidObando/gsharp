// <copyright file="PrefixBinding.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// Tells why a diagnostic of a prefix bind is reported (ADR-0225).
enum DiagnosticFinality {
    /// Every completion of the prefix reports this diagnostic at this span.
    Final,
    /// A completion can remove the diagnostic. It depends on text after the cut: a later declaration, the
    /// rest of an open function body, or the remaining members of an open type.
    FutureDependent,
    /// The cut causes the diagnostic, not the prefix. Examples are a parse error at the cut and a
    /// diagnostic in the text that the prefix bind removed.
    Artifact
}

/// Tells what follows the cut of a prefix bind (ADR-0225).
enum PrefixRemainder {
    /// Nothing follows the cut. This is left-to-right generation: any declaration can still follow.
    Nothing,
    /// The declarations after the cut in the original tree follow. This is a fill-in edit. The bind
    /// removes the text between the cut and the end of the member that contains the cut. At file level,
    /// it also removes the top-level statements after the cut.
    KeepDeclarations
}

/// Options of (cref:Compilation.Compilation.BindPrefix) (ADR-0225).
class PrefixBindOptions {
    /// Initializes a new instance of the (cref:PrefixBindOptions) class.
    /// @param remainder What follows the cut.
    /// @param includeScope Whether the result contains the symbols in scope at the cut.
    init(remainder PrefixRemainder, includeScope bool = true) {
        Remainder = remainder
        IncludeScope = includeScope
    }

    /// Gets what follows the cut.
    prop Remainder PrefixRemainder {
        get;
    }

    /// Gets a value that tells whether the result contains the symbols in scope at the cut.
    prop IncludeScope bool {
        get;
    }
}

/// A diagnostic of a prefix bind and its finality (ADR-0225).
class ClassifiedDiagnostic {
    internal init(diagnostic Diagnostic, finality DiagnosticFinality, reason string) {
        Diagnostic = diagnostic
        Finality = finality
        Reason = reason
    }

    /// Gets the diagnostic. Its location is in the text of the tree that the host gave.
    prop Diagnostic Diagnostic {
        get;
    }

    /// Gets the finality of the diagnostic.
    prop Finality DiagnosticFinality {
        get;
    }

    /// Gets the premise that can change after the cut, or an empty string for a final diagnostic.
    /// @remarks The values are stable: `later-declaration`, `later-member`, `later-overload`, `rest-of-body`,
    /// `rest-of-type`, `rest-of-statement` and `cut`. ADR-0225 defines them.
    prop Reason string {
        get;
    }

    /// Returns a string with the finality, the reason and the diagnostic.
    /// @returns The string.
    override func ToString() string -> if Reason.Length == 0 {
        "$Finality: $Diagnostic"
    } else {
        "$Finality ($Reason): $Diagnostic"
    }
}

/// A construct that is open at the cut of a prefix bind (ADR-0225).
class OpenConstruct {
    internal init(kind SyntaxKind, symbol Symbol?, expectedType TypeSymbol?) {
        Kind = kind
        Symbol = symbol
        ExpectedType = expectedType
    }

    /// Gets the syntax kind of the open construct, for example a block or an argument list.
    prop Kind SyntaxKind {
        get;
    }

    /// Gets the symbol that the construct declares: the function of an open body or the type of an open
    /// type body. It is `null` for other constructs.
    prop Symbol Symbol? {
        get;
    }

    /// Gets the return type of the function of an open body, or `null`.
    prop ExpectedType TypeSymbol? {
        get;
    }
}

/// The result of (cref:Compilation.Compilation.BindPrefix) (ADR-0225).
class PrefixBindResult {
    internal init(
        diagnostics ImmutableArray[ClassifiedDiagnostic],
        openConstructs ImmutableArray[OpenConstruct],
        symbolsInScope ImmutableArray[Symbol],
        compilation Compilation,
        syntaxTree SyntaxTree,
        host Compilation?,
        hostIndex int32,
        remainder PrefixRemainder
    ) {
        Diagnostics = diagnostics
        OpenConstructs = openConstructs
        Scope = symbolsInScope
        Compilation = compilation
        SyntaxTree = syntaxTree
        Host = host
        HostIndex = hostIndex
        Remainder = remainder
    }

    // ADR-0225 D6.6: the compilation that the host bound, the index of the host's tree in it, and what
    // follows the cut. A later bind reads them to reuse this result.
    internal prop Host Compilation? {
        get;
    }

    internal prop HostIndex int32 {
        get;
    }

    internal prop Remainder PrefixRemainder {
        get;
    }

    /// Gets the diagnostics of the prefix, in the order of (cref:Compilation.Compilation.GetDiagnostics).
    prop Diagnostics ImmutableArray[ClassifiedDiagnostic] {
        get;
    }

    /// Gets the constructs whose delimiters are open at the cut, innermost first.
    prop OpenConstructs ImmutableArray[OpenConstruct] {
        get;
    }

    /// Gets the symbols in scope at the cut, or an empty array when the options do not ask for them.
    prop Scope ImmutableArray[Symbol] {
        get;
    }

    /// Gets the compilation that the prefix bind made. It contains (cref:SyntaxTree) in place of the
    /// tree that the host gave.
    prop Compilation Compilation {
        get;
    }

    /// Gets the prefix tree. Its text is the text of the tree that the host gave, so positions agree.
    prop SyntaxTree SyntaxTree {
        get;
    }
}
