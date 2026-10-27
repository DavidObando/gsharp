// <copyright file="DelegateTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import SystemObject = System.Object

/// Represents a user-declared named delegate type (ADR-0059 / issue #255).
/// A `delegate Name(...) ` declaration produces a;
/// (cref:DelegateTypeSymbol) that the emitter materialises as a sealed
/// CLR class deriving from `System.MulticastDelegate` with a
/// runtime-implemented `.ctor` + `Invoke`.
/// @remarks Like (cref:StructSymbol) and (cref:InterfaceSymbol), a delegate
/// declared in source has no (cref:TypeSymbol.ClrType) at bind time —
/// the underlying CLR type only comes into being once the emitter has produced
/// the corresponding TypeDef row. Callers that need a CLR (cref:Type)
/// (for example, conversion classification) should fall back to the
/// (cref:EquivalentFunctionType) shape exposed below, which projects the
/// delegate onto an `Action<…>` / `Func<…>` instance.
class DelegateTypeSymbol : TypeSymbol {
    private let signatureLock object = SystemObject()
    private var equivalentFunctionType FunctionTypeSymbol?
    private var parameters ImmutableArray[ParameterSymbol]
    private var returnType TypeSymbol
    private var signatureVersion int32
    private var declarationSyntax DelegateDeclarationSyntax

    /// Initializes a new instance of the (cref:DelegateTypeSymbol) class.
    /// @param name The delegate type name (the identifier from `type Name = …`).
    /// @param packageName The package owning the delegate.
    /// @param accessibility The CLR accessibility of the emitted TypeDef.
    /// @param parameters The delegate's parameter symbols (names preserved for emit so consumers see
    /// meaningful names).
    /// @param returnType The delegate's return type. Use (cref:TypeSymbol.Void) for a void delegate.
    /// @param declaration The declaring syntax node (used to surface diagnostics later).
    init(
        name string,
        packageName string,
        accessibility Accessibility,
        parameters ImmutableArray[ParameterSymbol],
        returnType TypeSymbol,
        declaration DelegateDeclarationSyntax
    ) : base(name) {
        PackageName = packageName
        Accessibility = accessibility
        this.parameters = if parameters.IsDefault {
            ImmutableArray[ParameterSymbol].Empty
        } else {
            parameters
        }
        this.returnType = returnType ?? TypeSymbol.Void
        declarationSyntax = declaration
    }

    /// Gets the package the delegate is declared in.
    prop PackageName string {
        get;
    }

    /// Gets the CLR accessibility of the emitted delegate type.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the delegate's named parameters in declaration order.
    prop Parameters ImmutableArray[ParameterSymbol] {
        get {
            EnsureSignature()
            return parameters
        }
    }

    /// Gets the delegate's return type ((cref:TypeSymbol.Void) for a void delegate).
    prop ReturnType TypeSymbol {
        get {
            EnsureSignature()
            return returnType
        }
    }

    /// Gets the declaring syntax node. A constructed delegate reads its definition's node, so a
    /// re-point of the definition (issue #5324) reaches every cached construction.
    prop Declaration DelegateDeclarationSyntax -> if Definition is {} definition && !object.ReferenceEquals(
        definition,
        this
    ) {
        definition.Declaration
    } else {
        declarationSyntax
    }

    /// Re-points this reused delegate at the matching declaration in the edited tree (issue #5324).
    /// Only the backing syntax changes; the symbol identity is preserved. Call it only from
    /// (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration DelegateDeclarationSyntax) {
        declarationSyntax = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if Declaration is {} declaration {
        ImmutableArray.Create[SyntaxNode](declaration)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets the delegate's generic type parameters (issue #1503, ADR-0059
    /// follow-up). A non-generic named delegate carries an empty array; a
    /// generic named delegate (`delegate Predicate[T any](value T) bool`);
    /// carries one (cref:TypeParameterSymbol) per declared parameter.
    /// Both the open definition and every constructed instance expose the same
    /// type parameters (mirroring (cref:StructSymbol.TypeParameters));
    /// the emitter consumes these to mangle the TypeDef name with the
    /// backtick-arity suffix and to stamp one `GenericParam` row per slot.
    private var _typeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty

    prop TypeParameters ImmutableArray[TypeParameterSymbol] {
        get {
            return _typeParameters
        }
        private set {
            _typeParameters = value
        }
    }

    /// Gets the type arguments of a constructed generic delegate (issue #1503)
    /// (e.g. `[int32]` for `Predicate[int32]`). Empty on the open
    /// definition and on non-generic delegates.
    private var _typeArguments ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    prop TypeArguments ImmutableArray[TypeSymbol] {
        get {
            return _typeArguments
        }
        private set {
            _typeArguments = value
        }
    }

    /// Gets the open generic definition this delegate was constructed from
    /// (issue #1503), or `null` when this symbol IS the
    /// definition (or is non-generic). Mirrors (cref:StructSymbol.Definition).
    prop Definition DelegateTypeSymbol? {
        get;
        private set;
    }

    /// Gets a value indicating whether this symbol is the OPEN generic
    /// definition (issue #1503) — has type parameters but no type arguments yet.
    prop IsGenericDefinition bool -> !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty

    /// Gets the structural (cref:FunctionTypeSymbol) equivalent to this
    /// named delegate. The equivalent function type shares parameter and
    /// return types and lets existing func-based binder paths (overload
    /// resolution, conversion classification, type display) operate on a
    /// named delegate without per-symbol special-casing.
    prop EquivalentFunctionType FunctionTypeSymbol {
        get {
            EnsureSignature()
            if equivalentFunctionType == nil {
                let paramTypes = ImmutableArray.CreateBuilder[TypeSymbol](Parameters.Length)
                let variadicBuilder = ImmutableArray.CreateBuilder[bool](Parameters.Length)
                var anyVariadic = false
                for p in Parameters {
                    paramTypes.Add(p.Type)
                    variadicBuilder.Add(p.IsVariadic)
                    anyVariadic |= p.IsVariadic
                }
                // ADR-0102 follow-up / issue #818: a named delegate with a
                // trailing variadic parameter materialises a variadic
                // FunctionTypeSymbol so callers that take a `(T, ...U) -> R`
                // typed value and a named delegate value share identity.
                let variadicFlags = if anyVariadic {
                    variadicBuilder.MoveToImmutable()
                } else {
                    default(ImmutableArray[bool])
                }
                equivalentFunctionType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), variadicFlags, ReturnType)
            }
            return equivalentFunctionType!!
        }
    }

    /// Attaches the delegate's generic type parameters (issue #1503). Called
    /// once by the binder during delegate declaration binding
    /// before any constructed instance is materialized.
    /// @param typeParameters The bound type parameters in declaration order.
    func SetTypeParameters(typeParameters ImmutableArray[TypeParameterSymbol]) {
        TypeParameters = if typeParameters.IsDefault {
            ImmutableArray[TypeParameterSymbol].Empty
        } else {
            typeParameters
        }
    }

    /// Installs the signature on a declaration shell after all compilation
    /// type names have been registered.
    /// @param parameters The delegate parameters.
    /// @param returnType The delegate return type.
    func SetSignature(parameters ImmutableArray[ParameterSymbol], returnType TypeSymbol) {
        this.parameters = if parameters.IsDefault {
            ImmutableArray[ParameterSymbol].Empty
        } else {
            parameters
        }
        this.returnType = returnType ?? TypeSymbol.Void
        signatureVersion++
        equivalentFunctionType = nil
    }

    private func EnsureSignature() {
        if Definition is not{} definition {
            return
        }
        lock signatureLock {
            if signatureVersion == definition.signatureVersion {
                return
            }
            // Declaration shells may be constructed before SetSignature runs.
            // Reproject those instances when the definition's signature changes.
            ProjectSignature(definition)
            signatureVersion = definition.signatureVersion
            equivalentFunctionType = nil
        }
    }

    private func ProjectSignature(definition DelegateTypeSymbol) {
        let subst = Dictionary[TypeParameterSymbol, TypeSymbol](definition.TypeParameters.Length)
        for var i = 0; i < definition.TypeParameters.Length && i < TypeArguments.Length; i++ {
            subst[definition.TypeParameters[i]] = TypeArguments[i]
        }
        let substitutedParameters = ImmutableArray.CreateBuilder[ParameterSymbol](definition.Parameters.Length)
        for p in definition.Parameters {
            let substitutedType = StructSymbol.SubstituteTypeParameters(p.Type, subst)
            let clone = ParameterSymbol(p, substitutedType!!, p.DeclaringSyntax)
            if p.HasExplicitDefaultValue {
                clone.SetExplicitDefaultValue(p.ExplicitDefaultValue)
            }
            substitutedParameters.Add(clone)
        }
        parameters = substitutedParameters.MoveToImmutable()
        returnType = StructSymbol.SubstituteTypeParameters(definition.ReturnType, subst)!!
    }

    shared {
        private let ConstructedCache ConcurrentDictionary[
            (Definition DelegateTypeSymbol, ArgsKey TypeArgsKey),
            DelegateTypeSymbol
        ] = ConcurrentDictionary[(Definition DelegateTypeSymbol, ArgsKey TypeArgsKey), DelegateTypeSymbol]()

        /// Constructs a closed instance of a generic delegate definition with the
        /// supplied type arguments (issue #1503). The delegate's parameter and
        /// return types are substituted (`T` → `int32`), so the
        /// constructed delegate's (cref:EquivalentFunctionType), conversion
        /// classification, and emitted member references all observe the concrete
        /// shape. Identity is cached so two calls with the same definition +
        /// arguments return the SAME (cref:DelegateTypeSymbol) reference
        /// (preserving reference-equality semantics on (cref:TypeSymbol)),
        /// mirroring (cref:StructSymbol.Construct).
        /// @param definition The generic definition to instantiate. Returned unchanged when not an open generic
        /// definition.
        /// @param typeArguments The type arguments. Length must match (cref:TypeParameters).
        /// @returns A constructed (cref:DelegateTypeSymbol) whose (cref:Definition) is the original.
        @return: NotNullIfNotNull("definition")
        func Construct(definition DelegateTypeSymbol?, typeArguments ImmutableArray[TypeSymbol]) DelegateTypeSymbol? {
            if definition == nil || !definition.IsGenericDefinition {
                return definition
            }
            let key = BuildArgsKey(typeArguments)
            return ConstructedCache.GetOrAdd(
                (definition, key),
                (_(Definition DelegateTypeSymbol, ArgsKey TypeArgsKey)) -> CreateConstructed(definition, typeArguments)
            )
        }

        /// Removes all entries from the static constructed-delegate cache.
        /// Called by (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects and definition/argument symbols backed by
        /// a disposed metadata load context that would otherwise pin the
        /// context's memory indefinitely.
        internal func ClearCache() -> ConstructedCache.Clear()

        private func BuildArgsKey(typeArguments ImmutableArray[TypeSymbol]) TypeArgsKey -> TypeArgsKey(typeArguments)

        private func CreateConstructed(
            definition DelegateTypeSymbol,
            typeArguments ImmutableArray[TypeSymbol]
        ) DelegateTypeSymbol {
            // Cache nominal identity before projecting Invoke. Eager projection expands
            // recursive signatures such as D[T] -> D[D[T]] without a finite endpoint.
            return DelegateTypeSymbol(
                definition.Name,
                definition.PackageName,
                definition.Accessibility,
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                definition.Declaration
            ){
                TypeParameters = definition.TypeParameters,
                TypeArguments = typeArguments,
                Definition = definition,
                signatureVersion = -1
            }
        }
    }
}
