// <copyright file="BoundProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Bound program.
class BoundProgram {
    internal prop NativeProtocols NativeProtocolCompilationPlan? {
        get;
        set;
    }
    internal prop NativeProtocolOperations ImmutableDictionary[TypeSymbol, NativeProtocolOperations] ->
    NativeProtocols?.Operations ?? ImmutableDictionary[TypeSymbol, NativeProtocolOperations].Empty
    private var orderedFunctions Lazy[ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]]]

    /// Initializes a new instance of the (cref:BoundProgram) class.
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    convenience init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement
    ) {
        init(
            entryPointPackage,
            packages,
            diagnostics,
            functions,
            entryPoint,
            statement,
            ImmutableArray[StructSymbol].Empty
        )
    }

    /// Initializes a new instance of the (cref:BoundProgram) class.
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    /// @param structs User-defined struct types declared in this program, grouped by declaring package.
    /// @param interfaces User-defined interface types declared in this program (Phase 3.B.4).
    convenience init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol]
    ) {
        init(
            entryPointPackage,
            packages,
            diagnostics,
            functions,
            entryPoint,
            statement,
            structs,
            interfaces,
            ImmutableArray[EnumSymbol].Empty
        )
    }

    /// Initializes a new instance of the (cref:BoundProgram) class with declared enums (#193).
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    /// @param structs User-defined struct types declared in this program, grouped by declaring package.
    /// @param interfaces User-defined interface types declared in this program (Phase 3.B.4).
    /// @param enums User-defined enum types declared in this program (#193).
    convenience init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        enums ImmutableArray[EnumSymbol]
    ) {
        init(
            entryPointPackage,
            packages,
            diagnostics,
            functions,
            entryPoint,
            statement,
            structs,
            interfaces,
            enums,
            ImmutableArray[GlobalVariableSymbol].Empty
        )
    }

    /// Initializes a new instance of the (cref:BoundProgram) class with declared globals (#191).
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    /// @param structs User-defined struct types declared in this program, grouped by declaring package.
    /// @param interfaces User-defined interface types declared in this program (Phase 3.B.4).
    /// @param enums User-defined enum types declared in this program (#193).
    /// @param globals User-declared top-level `var`/`let`/`const` declarations (#191).
    convenience init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        enums ImmutableArray[EnumSymbol],
        globals ImmutableArray[GlobalVariableSymbol]
    ) {
        init(
            entryPointPackage,
            packages,
            diagnostics,
            functions,
            entryPoint,
            statement,
            structs,
            interfaces,
            enums,
            globals,
            ImmutableArray[DelegateTypeSymbol].Empty
        )
    }

    /// Initializes a new instance of the (cref:BoundProgram) class with declared named delegate types
    /// (ADR-0059 / issue #255).
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    /// @param structs User-defined struct types declared in this program, grouped by declaring package.
    /// @param interfaces User-defined interface types declared in this program (Phase 3.B.4).
    /// @param enums User-defined enum types declared in this program (#193).
    /// @param globals User-declared top-level `var`/`let`/`const` declarations (#191).
    /// @param delegates User-declared named delegate types in this program (ADR-0059).
    init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol],
        interfaces ImmutableArray[InterfaceSymbol],
        enums ImmutableArray[EnumSymbol],
        globals ImmutableArray[GlobalVariableSymbol],
        delegates ImmutableArray[DelegateTypeSymbol]
    ) {
        EntryPointPackage = entryPointPackage
        Packages = packages
        Diagnostics = diagnostics
        Functions = functions
        orderedFunctions = Lazy[ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]]](
            () -> BoundProgramOrder.SortFunctions(functions)
        )
        EntryPoint = entryPoint
        Statement = statement
        Structs = structs
        Interfaces = interfaces
        Enums = enums
        Globals = globals
        Delegates = if delegates.IsDefault {
            ImmutableArray[DelegateTypeSymbol].Empty
        } else {
            delegates
        }
    }

    /// Initializes a new instance of the (cref:BoundProgram) class.
    /// @param entryPointPackage The entry-point package; its name is exposed via (cref:PackageName) for
    /// back-compat.
    /// @param packages All distinct packages in this program, in declaration order.
    /// @param diagnostics The diagnostics.
    /// @param functions The functions. Each (cref:FunctionSymbol) key carries its owning package via
    /// (cref:FunctionSymbol.Package).
    /// @param entryPoint The entry-point function, or null if the compilation is a library.
    /// @param statement The statements.
    /// @param structs User-defined struct types declared in this program, grouped by declaring package.
    convenience init(
        entryPointPackage PackageSymbol,
        packages ImmutableArray[PackageSymbol],
        diagnostics ImmutableArray[Diagnostic],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement],
        entryPoint FunctionSymbol?,
        statement BoundBlockStatement,
        structs ImmutableArray[StructSymbol]
    ) {
        init(
            entryPointPackage,
            packages,
            diagnostics,
            functions,
            entryPoint,
            statement,
            structs,
            ImmutableArray[InterfaceSymbol].Empty
        )
    }

    /// Gets the entry-point package for this bound program. Its name is the
    /// namespace whose `<Program>` carries the assembly's entry
    /// point (when any).
    prop EntryPointPackage PackageSymbol {
        get;
    }

    /// Gets all distinct packages in this bound program, in declaration order.
    /// Each user-defined function (via (cref:FunctionSymbol.Package)) is
    /// tagged with one of these packages; the emitter produces one
    /// `<Program>` type per package, each in its declaring CLR
    /// namespace.
    prop Packages ImmutableArray[PackageSymbol] {
        get;
    }

    /// Gets the entry-point package name. Back-compat shim equivalent to
    /// `EntryPointPackage.Name`.
    prop PackageName string? -> EntryPointPackage?.Name

    /// Gets the diagnostics.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the functions.
    prop Functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }

    /// Gets the functions in (cref:SymbolSourceOrderComparer) order. The sort runs
    /// once per program and is shared by every pass that walks it.
    /// The binder supplies its already sorted post-inference view.
    internal prop OrderedFunctions ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]] {
        get {
            return orderedFunctions.Value
        }
        set {
            orderedFunctions = Lazy[ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]]](() -> value)
        }
    }

    /// Gets the synthesized or explicit entry-point function for this program,
    /// or null when the compilation produces a library. The body of the entry
    /// point is available via (cref:Functions) using this key.
    prop EntryPoint FunctionSymbol? {
        get;
    }

    /// Gets the statements.
    prop Statement BoundBlockStatement {
        get;
    }

    /// Gets the user-defined struct types declared in this program.
    /// Each struct carries its declaring package via (cref:StructSymbol.PackageName).
    prop Structs ImmutableArray[StructSymbol] {
        get;
    }

    /// Gets the user-defined interface types declared in this program (Phase 3.B.4).
    prop Interfaces ImmutableArray[InterfaceSymbol] {
        get;
    }

    /// Gets the user-defined enum types declared in this program (#193).
    /// Each enum carries its declaring package via (cref:EnumSymbol.PackageName).
    prop Enums ImmutableArray[EnumSymbol] {
        get;
    }

    /// Gets the user-declared top-level `var`/`let`/`const`
    /// declarations (#191). Each is emitted as a static `FieldDef` on the
    /// entry-point package's `<Program>` TypeDef so attribute
    /// metadata (#187) can attach to a real field row and so the global is
    /// observable from other assemblies.
    prop Globals ImmutableArray[GlobalVariableSymbol] {
        get;
    }

    /// Gets the user-declared named delegate types in this program (ADR-0059 / issue #255).
    /// Each delegate is emitted as a sealed CLR `TypeDef` deriving from
    /// `System.MulticastDelegate` with a runtime-implemented
    /// `.ctor` and `Invoke`.
    prop Delegates ImmutableArray[DelegateTypeSymbol] {
        get;
    }

    /// Gets the explicit (user-written) import symbols declared across all
    /// syntax trees. Implicit compiler-synthesized imports (e.g. the implicit
    /// `import System`) are excluded. Populated by
    /// (cref:Binding.Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)) from the bound global
    /// scope;
    /// the PDB emitter uses this to produce per-file `ImportScope` chains.
    private var _imports ImmutableArray[ImportSymbol] = ImmutableArray[ImportSymbol].Empty

    prop Imports ImmutableArray[ImportSymbol] {
        get {
            return _imports
        }
        internal set {
            _imports = value
        }
    }

    /// Gets the distinct friend-assembly names declared via
    /// `@assembly:InternalsVisibleTo("...")` (issue #1929/#1953).
    /// Populated from (cref:BoundGlobalScope.FriendAssemblies); the
    /// emitter writes one real
    /// (cref:System.Runtime.CompilerServices.InternalsVisibleToAttribute)
    /// row per entry.
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
    /// EXCEPT `InternalsVisibleTo` (see (cref:FriendAssemblies)).
    /// Populated from (cref:BoundGlobalScope.AssemblyAttributes); the
    /// emitter writes one real `CustomAttribute` row per entry via the
    /// same generic `CustomAttributeEncoder.EmitBoundAttribute` path
    /// used for every other declaration-level attribute.
    private var _assemblyAttributes ImmutableArray[BoundAttribute] = ImmutableArray[BoundAttribute].Empty

    prop AssemblyAttributes ImmutableArray[BoundAttribute] {
        get {
            return _assemblyAttributes
        }
        internal set {
            _assemblyAttributes = value
        }
    }

    /// Gets every file-level `@module:` annotation. The emitter writes
    /// one real `CustomAttribute` row on the module metadata row per entry.
    private var _moduleAttributes ImmutableArray[BoundAttribute] = ImmutableArray[BoundAttribute].Empty

    prop ModuleAttributes ImmutableArray[BoundAttribute] {
        get {
            return _moduleAttributes
        }
        internal set {
            _moduleAttributes = value
        }
    }

    private var _initializers ImmutableDictionary[
        (Owner Symbol, Static bool),
        BoundInitializationPlan
    ] = ImmutableDictionary[(Owner Symbol, Static bool), BoundInitializationPlan].Empty

    internal prop Initializers ImmutableDictionary[(Owner Symbol, Static bool), BoundInitializationPlan] {
        get {
            return _initializers
        }
        set {
            _initializers = value
        }
    }
}
