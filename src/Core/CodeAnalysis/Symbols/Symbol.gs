// <copyright file="Symbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO

/// Represents a symbol in the language.
abstract class Symbol {
    private var authoredDocumentation DocumentationComment?
    private var anchoredContainingType TypeSymbol?

    /// Initializes a new instance of the (cref:Symbol) class.
    /// @param name The symbol name.
    internal init(name string) {
        Name = name
    }

    /// Gets the kind of symbol this instance represents.
    abstract prop Kind SymbolKind {
        get;
    }

    /// Gets the name of the symbol.
    prop Name string {
        get;
    }

    /// Gets the user-written attributes attached to this symbol per ADR-0047.
    /// Defaults to empty; populated by the binder during declaration binding.
    private var _attributes ImmutableArray[BoundAttribute] = ImmutableArray[BoundAttribute].Empty

    prop Attributes ImmutableArray[BoundAttribute] {
        get {
            return _attributes
        }
        private set {
            _attributes = value
        }
    }

    /// Gets the syntax nodes that declare this symbol in source, or empty for
    /// symbols with no source declaration (imported CLR symbols, synthesized
    /// symbols). The analyzer framework's counterpart to Roslyn's
    /// `DeclaringSyntaxReferences` (ADR-0169).
    open prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> ImmutableArray[SyntaxNode].Empty

    /// Gets the source locations of this symbol's declarations — the Roslyn
    /// `Locations` analogue (ADR-0169). Empty for symbols with no source
    /// declaration.
    prop Locations ImmutableArray[TextLocation] {
        get {
            let declarations = DeclaringSyntaxNodes
            if declarations.IsEmpty {
                return ImmutableArray[TextLocation].Empty
            }
            let builder = ImmutableArray.CreateBuilder[TextLocation](declarations.Length)
            for declaration in declarations {
                builder.Add(declaration.Location)
            }
            return builder.MoveToImmutable()
        }
    }

    /// Gets a value indicating whether this symbol was synthesized by the
    /// compiler rather than declared in source — the Roslyn
    /// `IsImplicitlyDeclared` analogue (ADR-0169), approximated by G#'s
    /// compiler-generated name convention (a leading `<`).
    open prop IsImplicitlyDeclared bool -> Name.StartsWith("<", StringComparison.Ordinal)

    /// Gets the first declaration location, or a default (location-less)
    /// (cref:Text.TextLocation) for symbols with no source declaration.
    /// The struct-friendly target for Roslyn's
    /// `Locations.Length > 0 ? Locations[0] : null` idiom (ADR-0169).
    prop Location TextLocation -> if DeclaringSyntaxNodes is {IsEmpty: false} declarations {
        declarations[0].Location
    } else {
        default(TextLocation)
    }

    /// Gets the type that declares this member, or `null` for
    /// top-level symbols — the Roslyn `ContainingType` analogue
    /// (ADR-0169). Anchored fill-once when symbols surface through the
    /// analyzer driver or a (cref:SemanticModel); a symbol that can
    /// name its own declaring type says so through
    /// (cref:DefaultContainingType) instead of depending on having been
    /// anchored (issue #3920), and only a symbol with neither reports null.
    prop ContainingType TypeSymbol? -> if anchoredContainingType == nil {
        (anchoredContainingType = DefaultContainingType())
    } else {
        anchoredContainingType
    }

    /// Gets the display name of the package (namespace) this symbol lives in,
    /// or `null` when unknown — the string-valued counterpart
    /// of Roslyn's `ContainingNamespace.ToDisplayString()` idiom
    /// (ADR-0169).
    open prop ContainingNamespace string? -> ContainingType?.ContainingNamespace

    /// Gets the attributes attached to this symbol — the Roslyn
    /// `ISymbol.GetAttributes()` analogue (ADR-0169, issue #4436); the
    /// same list as (cref:Attributes).
    /// @returns The attributes.
    func GetAttributes() ImmutableArray[BoundAttribute] -> Attributes

    /// Renders this symbol in the requested format — the Roslyn
    /// `ToDisplayString(SymbolDisplayFormat)` analogue (ADR-0169).
    /// (cref:DisplayFormat.FullyQualified) mirrors Roslyn's
    /// fully-qualified format, including the `global::` prefix, so
    /// string comparisons in migrated analyzers carry over verbatim.
    /// @param format The rendering format.
    /// @returns The rendered symbol name.
    open func ToDisplayString(format DisplayFormat) string -> if format == DisplayFormat.FullyQualified &&
        ContainingNamespace is {Length: > 0} ns {
        "global::$ns.$Name"
    } else {
        Name
    }

    /// Writes the symbol to the specified text writer.
    /// @param writer The writer to write the symbol to.
    func WriteTo(writer TextWriter) {
        SymbolPrinter.WriteTo(this, writer)
    }

    /// Gives a string representation of this symbol.
    /// @returns A string representation of the symbol.
    open override func ToString() string {
        {
            using let writer = StringWriter()
            WriteTo(writer)
            return writer.ToString()
        }
    }

    /// Gets the structured documentation for this symbol (ADR-0057 §4), or
    /// `null` when the symbol is undocumented. The default returns the
    /// authored documentation set by the binder (G# symbols); imported CLR symbols
    /// override this to resolve documentation from the ingested `.xml` on demand.
    /// @returns The documentation comment, or `null` when undocumented.
    open func GetDocumentation() DocumentationComment? {
        return this.authoredDocumentation
    }

    /// Sets the bound-attribute list for this symbol. Called by the binder
    /// once attribute resolution for the owning declaration completes.
    /// @param attributes The bound attributes to attach.
    internal func SetAttributes(attributes ImmutableArray[BoundAttribute]) {
        Attributes = attributes
    }

    /// Attaches authored documentation parsed from a G# doc comment. Called by the
    /// binder once the owning declaration's doc block is parsed into the model.
    /// @param documentation The parsed documentation comment.
    internal func SetDocumentation(documentation DocumentationComment) {
        this.authoredDocumentation = documentation
    }

    /// Anchors this symbol to its declaring type if it has none yet
    /// (idempotent, mirroring `BoundNode.AnchorSyntax`).
    /// @param containingType The declaring type.
    internal func AnchorContainingType(containingType TypeSymbol) {
        anchoredContainingType ??= containingType
    }

    /// Assigns the declaring type outright, replacing whatever was there. The
    /// binder's `SetContainingType` entry points use this; analyzer-side
    /// anchoring uses (cref:AnchorContainingType), which is fill-once.
    /// @param containingType The declaring type, or null.
    internal func SetContainingTypeCore(containingType TypeSymbol?) -> anchoredContainingType = containingType

    /// The declaring type this symbol can determine on its own, consulted when
    /// nothing has anchored one (issue #3920). Null by default: most symbols
    /// learn their container only from the declaration that holds them.
    /// @returns The declaring type, or null.
    internal open func DefaultContainingType() TypeSymbol? -> nil
}
