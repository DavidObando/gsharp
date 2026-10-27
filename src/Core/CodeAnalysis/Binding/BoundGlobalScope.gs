// <copyright file="BoundGlobalScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Global scope-level binding. Enables compilations to be chained.
class BoundGlobalScope {
    /// Initializes a new instance of the (cref:BoundGlobalScope) class.
    /// @param previous Previous compilation global scope.
    /// @param package The entry-point package for the current compilation.
    /// @param packages All distinct packages declared in the current compilation, in declaration order.
    /// @param diagnostics Diagnostics for the current compilation.
    /// @param imports Imports in the current compilation.
    /// @param functions Functions in the current compilation.
    /// @param variables Variables in the current compilation.
    /// @param entryPoint The entry-point function for this compilation, or null if the compilation is a
    /// library.
    /// @param statements Statements in the current compilation.
    convenience init(
        previous BoundGlobalScope?,
        $package PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        imports ImmutableArray[ImportSymbol],
        functions ImmutableArray[FunctionSymbol],
        variables ImmutableArray[VariableSymbol],
        entryPoint FunctionSymbol?,
        statements ImmutableArray[BoundStatement]
    ) {
        init(
            previous,
            $package,
            packages,
            diagnostics,
            imports,
            functions,
            variables,
            ImmutableDictionary[string, TypeSymbol].Empty,
            ImmutableArray[StructSymbol].Empty,
            entryPoint,
            statements
        )
    }

    /// Initializes a new instance of the (cref:BoundGlobalScope) class
    /// with declared type aliases.
    /// @param previous Previous compilation global scope.
    /// @param package The entry-point package for the current compilation.
    /// @param packages All distinct packages declared in the current compilation, in declaration order.
    /// @param diagnostics Diagnostics for the current compilation.
    /// @param imports Imports in the current compilation.
    /// @param functions Functions in the current compilation.
    /// @param variables Variables in the current compilation.
    /// @param typeAliases Type aliases declared in the current compilation.
    /// @param structs User-defined struct types declared in the current compilation.
    /// @param interfaces User-defined interface types declared in the current compilation (Phase 3.B.4).
    /// @param entryPoint The entry-point function for this compilation, or null if the compilation is a
    /// library.
    /// @param statements Statements in the current compilation.
    convenience init(
        previous BoundGlobalScope?,
        $package PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        imports ImmutableArray[ImportSymbol],
        functions ImmutableArray[FunctionSymbol],
        variables ImmutableArray[VariableSymbol],
        typeAliases ImmutableDictionary[string, TypeSymbol],
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        entryPoint FunctionSymbol?,
        statements ImmutableArray[BoundStatement]
    ) {
        init(
            previous,
            $package,
            packages,
            diagnostics,
            imports,
            functions,
            variables,
            typeAliases,
            structs,
            interfaces,
            ImmutableArray[EnumSymbol].Empty,
            entryPoint,
            statements
        )
    }

    /// Initializes a new instance of the (cref:BoundGlobalScope) class with declared enums (#193).
    /// @param previous Previous compilation global scope.
    /// @param package The entry-point package for the current compilation.
    /// @param packages All distinct packages declared in the current compilation, in declaration order.
    /// @param diagnostics Diagnostics for the current compilation.
    /// @param imports Imports in the current compilation.
    /// @param functions Functions in the current compilation.
    /// @param variables Variables in the current compilation.
    /// @param typeAliases Type aliases declared in the current compilation.
    /// @param structs User-defined struct types declared in the current compilation.
    /// @param interfaces User-defined interface types declared in the current compilation (Phase 3.B.4).
    /// @param enums User-defined enum types declared in the current compilation (#193).
    /// @param entryPoint The entry-point function for this compilation, or null if the compilation is a
    /// library.
    /// @param statements Statements in the current compilation.
    convenience init(
        previous BoundGlobalScope?,
        $package PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        imports ImmutableArray[ImportSymbol],
        functions ImmutableArray[FunctionSymbol],
        variables ImmutableArray[VariableSymbol],
        typeAliases ImmutableDictionary[string, TypeSymbol],
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        enums ImmutableArray[EnumSymbol],
        entryPoint FunctionSymbol?,
        statements ImmutableArray[BoundStatement]
    ) {
        init(
            previous,
            $package,
            packages,
            diagnostics,
            imports,
            functions,
            variables,
            typeAliases,
            structs,
            interfaces,
            enums,
            ImmutableArray[DelegateTypeSymbol].Empty,
            entryPoint,
            statements
        )
    }

    /// Initializes a new instance of the (cref:BoundGlobalScope) class with declared named delegate types
    /// (ADR-0059 / issue #255).
    /// @param previous Previous compilation global scope.
    /// @param package The entry-point package for the current compilation.
    /// @param packages All distinct packages declared in the current compilation, in declaration order.
    /// @param diagnostics Diagnostics for the current compilation.
    /// @param imports Imports in the current compilation.
    /// @param functions Functions in the current compilation.
    /// @param variables Variables in the current compilation.
    /// @param typeAliases Type aliases declared in the current compilation.
    /// @param structs User-defined struct types declared in the current compilation.
    /// @param interfaces User-defined interface types declared in the current compilation (Phase 3.B.4).
    /// @param enums User-defined enum types declared in the current compilation (#193).
    /// @param delegates User-declared named delegate types in the current compilation (ADR-0059).
    /// @param entryPoint The entry-point function for this compilation, or null if the compilation is a
    /// library.
    /// @param statements Statements in the current compilation.
    init(
        previous BoundGlobalScope?,
        $package PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        imports ImmutableArray[ImportSymbol],
        functions ImmutableArray[FunctionSymbol],
        variables ImmutableArray[VariableSymbol],
        typeAliases ImmutableDictionary[string, TypeSymbol],
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        enums ImmutableArray[EnumSymbol],
        delegates ImmutableArray[DelegateTypeSymbol],
        entryPoint FunctionSymbol?,
        statements ImmutableArray[BoundStatement]
    ) {
        Previous = previous
        Package = $package
        Packages = packages
        Diagnostics = diagnostics
        Imports = imports
        Functions = functions
        Variables = variables
        TypeAliases = typeAliases
        Structs = structs
        Interfaces = interfaces
        Enums = enums
        Delegates = if delegates.IsDefault {
            ImmutableArray[DelegateTypeSymbol].Empty
        } else {
            delegates
        }
        EntryPoint = entryPoint
        Statements = statements
    }

    /// Initializes a new instance of the (cref:BoundGlobalScope) class
    /// with declared type aliases.
    /// @param previous Previous compilation global scope.
    /// @param package The entry-point package for the current compilation.
    /// @param packages All distinct packages declared in the current compilation, in declaration order.
    /// @param diagnostics Diagnostics for the current compilation.
    /// @param imports Imports in the current compilation.
    /// @param functions Functions in the current compilation.
    /// @param variables Variables in the current compilation.
    /// @param typeAliases Type aliases declared in the current compilation.
    /// @param structs User-defined struct types declared in the current compilation.
    /// @param entryPoint The entry-point function for this compilation, or null if the compilation is a
    /// library.
    /// @param statements Statements in the current compilation.
    convenience init(
        previous BoundGlobalScope?,
        $package PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        imports ImmutableArray[ImportSymbol],
        functions ImmutableArray[FunctionSymbol],
        variables ImmutableArray[VariableSymbol],
        typeAliases ImmutableDictionary[string, TypeSymbol],
        structs ImmutableArray[StructSymbol],
        entryPoint FunctionSymbol?,
        statements ImmutableArray[BoundStatement]
    ) {
        init(
            previous,
            $package,
            packages,
            diagnostics,
            imports,
            functions,
            variables,
            typeAliases,
            structs,
            ImmutableArray[InterfaceSymbol].Empty,
            entryPoint,
            statements
        )
    }

    /// Gets the previous compilation global scope.
    prop Previous BoundGlobalScope? {
        get;
    }

    /// Gets the entry-point package symbol for the current compilation. This
    /// is the package owning the synthesized top-level statements or the
    /// explicit `Main` function, and it is the package whose
    /// `<Program>` type holds the assembly's entry point.
    prop Package PackageSymbol {
        get;
    }

    /// Gets all distinct packages declared across the current compilation's
    /// syntax trees, in first-seen declaration order. Each user-defined
    /// function is tagged with its declaring package via
    /// (cref:FunctionSymbol.Package).
    prop Packages ImmutableArray[PackageSymbol] {
        get;
    }

    /// Gets the diagnostics for the current compilation.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the imports declared directly by <em>this</em> compilation's own
    /// syntax trees — NOT the transitively-visible import set (issue #2101).
    /// Mirrors (cref:Functions)/(cref:Variables), which have
    /// always been per-level deltas rather than a cumulative snapshot. Callers
    /// that need every import visible across a chained REPL session (e.g.
    /// emit, which must see imports from every prior submission) should use
    /// (cref:GetCumulativeImports) instead of reading this property
    /// directly on a single link of the (cref:Previous) chain.
    prop Imports ImmutableArray[ImportSymbol] {
        get;
    }

    /// Gets the functions in the current compilation.
    prop Functions ImmutableArray[FunctionSymbol] {
        get;
    }

    /// Gets the variables in the current compilation.
    prop Variables ImmutableArray[VariableSymbol] {
        get;
    }

    /// Gets the type aliases declared in the current compilation.
    prop TypeAliases ImmutableDictionary[string, TypeSymbol] {
        get;
    }

    /// Gets the user-defined struct types declared in the current compilation.
    prop Structs ImmutableArray[StructSymbol] {
        get;
    }

    /// Gets the user-defined interface types declared in the current compilation (Phase 3.B.4).
    prop Interfaces ImmutableArray[InterfaceSymbol] {
        get;
    }

    /// Gets the user-defined enum types declared in the current compilation (#193).
    prop Enums ImmutableArray[EnumSymbol] {
        get;
    }

    /// Gets the user-declared named delegate types in the current compilation (ADR-0059 / issue #255).
    prop Delegates ImmutableArray[DelegateTypeSymbol] {
        get;
    }

    /// Gets the synthesized or explicit entry-point function for this compilation,
    /// or null if the compilation produces a library (no entry point).
    prop EntryPoint FunctionSymbol? {
        get;
    }

    /// Gets the statements in the current compilation.
    prop Statements ImmutableArray[BoundStatement] {
        get;
    }

    /// Gets the active preprocessor symbol set used by
    /// `[Conditional("SYMBOL")]` call-site elision (ADR-0047 §6 /
    /// issue #176). Threaded onto the bound global scope so that
    /// (cref:Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)) — which builds its own scope
    /// chain
    /// from this snapshot — can rehydrate the same symbol set when binding
    /// function bodies. Defaults to (cref:ImmutableHashSet{T}.Empty).
    private var _preprocessorSymbols ImmutableHashSet[string] = ImmutableHashSet[string].Empty

    prop PreprocessorSymbols ImmutableHashSet[string] {
        get {
            return _preprocessorSymbols
        }
        internal set {
            _preprocessorSymbols = value
        }
    }

    /// Gets the distinct set of friend-assembly names this compilation
    /// declares via `@assembly:InternalsVisibleTo("...")` annotations
    /// (issue #1929/#1953). The emitter writes a real
    /// (cref:System.Runtime.CompilerServices.InternalsVisibleToAttribute)
    /// custom attribute row for each entry so the producer genuinely opts
    /// in to cross-assembly internal access — there is no consumer-side
    /// name-based heuristic.
    private var _friendAssemblies ImmutableArray[string] = ImmutableArray[string].Empty

    prop FriendAssemblies ImmutableArray[string] {
        get {
            return _friendAssemblies
        }
        internal set {
            _friendAssemblies = value
        }
    }

    /// Gets every file-level `@assembly:` annotation (issue #2237)
    /// EXCEPT `InternalsVisibleTo` (see (cref:FriendAssemblies)),
    /// bound through the general attribute binder so any C#-parity assembly
    /// attribute (`AssemblyVersionAttribute`,
    /// `AssemblyMetadataAttribute`, a same-compilation user attribute,
    /// ...) becomes a real assembly-level `CustomAttribute` row.
    private var _assemblyAttributes ImmutableArray[BoundAttribute] = ImmutableArray[BoundAttribute].Empty

    prop AssemblyAttributes ImmutableArray[BoundAttribute] {
        get {
            return _assemblyAttributes
        }
        internal set {
            _assemblyAttributes = value
        }
    }

    /// Gets every file-level `@module:` annotation, bound through the
    /// general attribute binder for emission on the module metadata row.
    private var _moduleAttributes ImmutableArray[BoundAttribute] = ImmutableArray[BoundAttribute].Empty

    prop ModuleAttributes ImmutableArray[BoundAttribute] {
        get {
            return _moduleAttributes
        }
        internal set {
            _moduleAttributes = value
        }
    }

    /// Gets the interactive submission import set this scope was bound with
    /// (ADR-0156 Phase 2), or `null` for an ordinary
    /// compilation. Carried on the scope so `BindProgram`'s
    /// freshly-derived scope chain rehydrates prior-submission metadata
    /// lookup when binding member bodies.
    prop SubmissionImports SubmissionImports? {
        get;
        internal set;
    }

    /// Gets or sets every anonymous-class type (issue #2224) synthesized
    /// while binding this compilation's top-level statements and (once
    /// `Binder.BindProgram` runs) its function/method bodies.
    /// `Binder.BindProgram` unions this set into the emitted
    /// `BoundProgram.Structs` so every synthesized shape gets a real
    /// TypeDef, regardless of which phase's bind pass first encountered its
    /// shape.
    private var _anonymousTypes ImmutableArray[StructSymbol] = ImmutableArray[StructSymbol].Empty

    internal prop AnonymousTypes ImmutableArray[StructSymbol] {
        get {
            return _anonymousTypes
        }
        set {
            _anonymousTypes = value
        }
    }

    /// Gets or sets the map from each "rich" anonymous-object literal (one
    /// carrying a base/interface clause, method, or event — ADR-0146 / issue
    /// #2243) to its compiler-synthesized backing class. Populated while
    /// binding the global scope and consumed by `Binder.BindProgram`
    /// (which rehydrates it onto the fresh body-binding scope) so a literal
    /// appearing inside a function or method body binds to the right
    /// synthesized class.
    private var _richAnonymousClassMap Dictionary[AnonymousClassExpressionSyntax, StructSymbol] = Dictionary[
        AnonymousClassExpressionSyntax,
        StructSymbol
    ]()

    internal prop RichAnonymousClassMap Dictionary[AnonymousClassExpressionSyntax, StructSymbol] {
        get {
            return _richAnonymousClassMap
        }
        set {
            _richAnonymousClassMap = value
        }
    }

    private var _richAnonymousObjectPlans Dictionary[
        RichAnonymousObjectBindingKey,
        RichAnonymousObjectPlan
    ] = Dictionary[RichAnonymousObjectBindingKey, RichAnonymousObjectPlan]()

    internal prop RichAnonymousObjectPlans Dictionary[RichAnonymousObjectBindingKey, RichAnonymousObjectPlan] {
        get {
            return _richAnonymousObjectPlans
        }
        set {
            _richAnonymousObjectPlans = value
        }
    }

    private var _latestRichAnonymousObjectPlans Dictionary[StructSymbol, RichAnonymousObjectPlan] = Dictionary[
        StructSymbol,
        RichAnonymousObjectPlan
    ]()

    internal prop LatestRichAnonymousObjectPlans Dictionary[StructSymbol, RichAnonymousObjectPlan] {
        get {
            return _latestRichAnonymousObjectPlans
        }
        set {
            _latestRichAnonymousObjectPlans = value
        }
    }

    private var _structuralAdapters StructuralAdapterRegistry = StructuralAdapterRegistry()

    internal prop StructuralAdapters StructuralAdapterRegistry {
        get {
            return _structuralAdapters
        }
        set {
            _structuralAdapters = value
        }
    }

    internal prop HasNativeProtocols bool ->
    Interfaces.Any((type InterfaceSymbol) -> type.IsProtocol) ||
        StructuralAdapters.HasNativeProtocolDeclarations ||
        StructuralAdapters
        .ProtocolEntries
        .Count != 0 ||
        StructuralAdapters
        .ImportedProtocolEntries
        .Count != 0 ||
        StructuralAdapters
        .ProtocolOperations
        .Count != 0

    /// Gets or sets the ref-kind delegate cache (issue #3501 A2) shared with
    /// `BindProgram`'s body-binding pass so a function-type shape with
    /// `ref`/`out`/`in` slots resolves to one synthesized
    /// delegate symbol across both passes.
    internal prop RefDelegateCache SynthesizedRefDelegateCache?

    /// Gets or sets the anonymous-class-literal type cache (issue #2224)
    /// shared with `BindProgram`'s body-binding pass (issue #5281), so a shape
    /// bound in a top-level statement and the same shape bound in a body resolve
    /// to one synthesized type, and the two passes cannot both emit
    /// `<>AnonymousType0`.
    internal prop AnonymousTypeCache AnonymousTypeCache?

    /// Returns every import visible across the whole (cref:Previous)
    /// chain, oldest submission first (issue #2101). This is the cumulative
    /// view that (cref:Imports) itself used to provide directly —
    /// moved here (an explicit, one-time O(chain length) walk) so that
    /// per-level binding ((cref:Binder.BindGlobalScope(BoundGlobalScope, ImmutableArray{Syntax.SyntaxTree},
    /// Symbols.ReferenceResolver, bool, ImmutableHashSet{string}, bool)))
    /// no longer has to re-flatten (and get re-flattened by) the entire
    /// history on every single chained submission.
    /// @returns The cumulative imports, oldest-declared first.
    func GetCumulativeImports() ImmutableArray[ImportSymbol] {
        let chain = Stack[BoundGlobalScope]()
        var current BoundGlobalScope? = this
        while current != nil {
            chain.Push(current)
            current = current.Previous
        }
        let builder = ImmutableArray.CreateBuilder[ImportSymbol]()
        while chain.Count > 0 {
            builder.AddRange(chain.Pop().Imports)
        }
        return builder.ToImmutable()
    }
}
