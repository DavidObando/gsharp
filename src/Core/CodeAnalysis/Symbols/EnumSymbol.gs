// <copyright file="EnumSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis

/// Represents a user-defined enum type backed by (cref:int).
class EnumSymbol : TypeSymbol {
    private var members ImmutableArray[EnumMemberSymbol]
    private var declarationSyntax EnumDeclarationSyntax

    /// Initializes a new instance of the (cref:EnumSymbol) class.
    /// @param name The enum type name.
    /// @param accessibility The enum accessibility.
    /// @param packageName The declaring package name.
    /// @param declaration The declaring syntax node.
    init(name string, accessibility Accessibility, packageName string, declaration EnumDeclarationSyntax) : base(name) {
        Accessibility = accessibility
        PackageName = packageName
        declarationSyntax = declaration
        members = ImmutableArray[EnumMemberSymbol].Empty
        Definition = this
    }

    /// Gets the enum accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the package the enum lives in.
    prop PackageName string {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> PackageName

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop IsValueType bool -> true

    /// Gets the declaring syntax node. A constructed nested enum reads its definition's node, so a
    /// re-point of the definition (issue #5324) reaches every cached construction.
    prop Declaration EnumDeclarationSyntax -> if Definition is {} definition && !object.ReferenceEquals(
        definition,
        this
    ) {
        definition.Declaration
    } else {
        declarationSyntax
    }

    /// Re-points this reused enum at the matching declaration in the edited tree (issue #5324).
    /// Only the backing syntax changes; the symbol identity is preserved. Call it only from
    /// (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration EnumDeclarationSyntax) {
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

    /// Gets the enum members in declaration order.
    prop Members ImmutableArray[EnumMemberSymbol] -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
        Definition!!.Members
    } else {
        members
    }

    /// Gets the open declaration represented by this symbol. Definitions point
    /// to themselves; constructed nested references point to the declaration.
    prop Definition EnumSymbol? {
        get;
        private set;
    }

    /// Gets the flattened enclosing construction arguments in CLR order.
    private var _enclosingTypeArguments ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    prop EnclosingTypeArguments ImmutableArray[TypeSymbol] {
        get {
            return _enclosingTypeArguments
        }
        private set {
            _enclosingTypeArguments = value
        }
    }

    /// Gets metadata-only generic parameters used when a nested enum is reified
    /// over generic enclosing types.
    private var _typeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty

    prop TypeParameters ImmutableArray[TypeParameterSymbol] {
        get {
            return _typeParameters
        }
        private set {
            _typeParameters = value
        }
    }

    /// Gets the CLR underlying enum for values.
    prop UnderlyingType TypeSymbol -> TypeSymbol.Int32

    /// Sets (cref:Symbol.ContainingType) (ADR-0110 / issue #910).
    /// @param containingType The enclosing user-defined type.
    func SetContainingType(containingType TypeSymbol?) {
        SetContainingTypeCore(containingType)
    }

    /// Sets the enum members after the owning enum symbol has been created.
    /// @param members The enum members in declaration order.
    func SetMembers(members ImmutableArray[EnumMemberSymbol]) {
        this.members = members
    }

    /// Looks up an enum member by name.
    /// @param name The member name.
    /// @param member The found member, if any.
    /// @returns True if the member exists.
    func TryGetMember(name string, @NotNullWhen(true) out member EnumMemberSymbol?) bool {
        for candidate in Members {
            if string.Equals(candidate.Name, name, StringComparison.Ordinal) {
                member = candidate
                return true
            }
        }
        member = nil
        return false
    }

    /// Sets metadata-only generic parameters for the reified nested enum TypeDef.
    /// @param typeParameters The flattened enclosing parameters.
    internal func SetTypeParameters(typeParameters ImmutableArray[TypeParameterSymbol]) {
        TypeParameters = if typeParameters.IsDefault {
            ImmutableArray[TypeParameterSymbol].Empty
        } else {
            typeParameters
        }
    }

    shared {
        private let ConstructedNestedCache ConcurrentDictionary[
            (Definition EnumSymbol, EnclosingArgs TypeArgsKey),
            EnumSymbol
        ] = ConcurrentDictionary[(Definition EnumSymbol, EnclosingArgs TypeArgsKey), EnumSymbol]()

        /// Constructs a nested enum reference over its enclosing type arguments.
        /// @param nestedDefinition The open nested enum declaration.
        /// @param enclosingTypeArguments Flattened enclosing arguments in CLR order.
        /// @returns The interned constructed reference.
        @return: NotNullIfNotNull("nestedDefinition")
        func ConstructNested(
            nestedDefinition EnumSymbol?,
            enclosingTypeArguments ImmutableArray[TypeSymbol]
        ) EnumSymbol? {
            if nestedDefinition == nil || enclosingTypeArguments.IsDefaultOrEmpty {
                return nestedDefinition
            }
            let def = nestedDefinition.Definition ?? nestedDefinition
            let key = TypeArgsKey(enclosingTypeArguments)
            return ConstructedNestedCache.GetOrAdd(
                (def, key),
                (_(Definition EnumSymbol, EnclosingArgs TypeArgsKey)) -> CreateConstructedNested(
                    def,
                    enclosingTypeArguments
                )
            )
        }

        /// Substitutes the enclosing generic parameters of a nested enum.
        /// @param nested The enum definition or constructed reference.
        /// @param substitute The type substitution.
        /// @returns The substituted enclosing vector, or `default` when none exists.
        func SubstituteEnclosingArguments(nested EnumSymbol?, substitute((TypeSymbol) -> TypeSymbol)?) ImmutableArray[
            TypeSymbol
        ] {
            if nested == nil || substitute == nil {
                return default(ImmutableArray[TypeSymbol])
            }
            var current ImmutableArray[TypeSymbol]
            if !nested.EnclosingTypeArguments.IsDefaultOrEmpty {
                current = nested.EnclosingTypeArguments
            } else {
                let enclosingParameters = StructSymbol.CollectEnclosingTypeParameters(nested)
                if enclosingParameters.IsDefaultOrEmpty {
                    return default(ImmutableArray[TypeSymbol])
                }
                let currentBuilder = ImmutableArray.CreateBuilder[TypeSymbol](enclosingParameters.Length)
                for parameter in enclosingParameters {
                    currentBuilder.Add(parameter)
                }
                current = currentBuilder.MoveToImmutable()
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](current.Length)
            for argument in current {
                builder.Add(substitute(argument))
            }
            return builder.MoveToImmutable()
        }

        /// Closes a nested enum over the generic parameters currently in lexical scope.
        /// @param nested The open nested enum.
        /// @param typeParameters Type parameters indexed by source name.
        /// @returns The constructed nested enum, or [`nested`](paramref) when its enclosing parameters are not
        /// all in scope.
        @return: NotNullIfNotNull("nested")
        internal func ConstructNestedFromTypeParameterScope(
            nested EnumSymbol?,
            typeParameters IReadOnlyDictionary[string, TypeParameterSymbol]?
        ) EnumSymbol? {
            if nested == nil || !nested.EnclosingTypeArguments.IsDefaultOrEmpty || typeParameters == nil {
                return nested
            }
            let enclosingParameters = StructSymbol.CollectEnclosingTypeParameters(nested)
            let enclosingArguments = ImmutableArray.CreateBuilder[TypeSymbol](enclosingParameters.Length)
            for parameter in enclosingParameters {
                if !typeParameters.TryGetValue(parameter.Name, out var argument) {
                    return nested
                }
                enclosingArguments.Add(argument)
            }
            return if enclosingArguments.Count == 0 {
                nested
            } else {
                ConstructNested(nested.Definition ?? nested, enclosingArguments.MoveToImmutable())
            }
        }

        /// Clears constructed nested enum symbols between compilations.
        internal func ClearCache() -> ConstructedNestedCache.Clear()

        private func CreateConstructedNested(
            definition EnumSymbol,
            enclosingTypeArguments ImmutableArray[TypeSymbol]
        ) EnumSymbol {
            let constructed = EnumSymbol(
                definition.Name,
                definition.Accessibility,
                definition.PackageName,
                definition.Declaration
            ){Definition = definition, EnclosingTypeArguments = enclosingTypeArguments}
            constructed.SetContainingType(definition.ContainingType)
            return constructed
        }
    }
}
