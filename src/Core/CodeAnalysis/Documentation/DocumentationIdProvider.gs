// <copyright file="DocumentationIdProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Generic
import System.Globalization
import System.Linq
import System.Reflection
import System.Text

/// Computes documentation ids ("DocIDs") in the exact format Roslyn's
/// `DocumentationCommentId` / the C# language specification uses. This is the
/// single shared component behind both documentation <em>ingestion</em> (reflected
/// CLR members, ADR-0057 §6) and documentation <em>emission</em> (source symbols,
/// ADR-0057 §5): the two paths must never diverge, so they share this code and one
/// golden corpus.
/// @remarks A DocID is a prefix (`T:`, `M:`, `P:`, `F:`, `E:`,
/// `N:`) followed by the member's fully-qualified, language-neutral signature:
/// nested types separated by `.`, generic arity as ``n` (types) / ```n`
/// (methods), constructed type arguments in `{…}`, by-ref `@`, arrays
/// `[]`, pointers `*`, and a `~ReturnType` suffix on conversion operators.
shared class DocumentationIdProvider {
    /// Computes the DocID for any reflected member, dispatching on its kind.
    /// @param member The reflected member.
    /// @returns The DocID, or `null` when the member kind is unsupported.
    func GetDocumentationId(member MemberInfo) string? {
        return switch member {
            case type is Type: GetDocumentationId(type)
            case method is MethodBase: GetDocumentationId(method)
            case property is PropertyInfo: GetDocumentationId(property)
            case field is FieldInfo: GetDocumentationId(field)
            case event is EventInfo: GetDocumentationId(event)
            default: default(string?)
        }
    }

    /// Computes the `T:` DocID for a reflected type.
    /// @param type The reflected type.
    /// @returns The type DocID.
    func GetDocumentationId(type Type) string {
        let builder = StringBuilder("T:")
        AppendTypeDeclarationName(builder, NormalizeToGenericDefinition(type))
        return builder.ToString()
    }

    /// Computes the `M:` DocID for a reflected method or constructor.
    /// @param method The reflected method or constructor.
    /// @returns The method DocID.
    func GetDocumentationId(method MethodBase) string {
        var method = method
        // Normalize a member reflected off a constructed generic type (e.g. List<int>.Add)
        // to its counterpart on the generic definition (List<>.Add) so both the declaration
        // path (`List`1.Add`) AND the parameter signature (`(`0)` instead of `(System.Int32)`)
        // match the XML doc key. Without this, every member on a constructed generic type
        // would produce a DocID Roslyn never emits (issue #393).
        method = NormalizeToOpenGenericDeclaringType(method) ?? method
        let builder = StringBuilder("M:")
        AppendTypeDeclarationName(builder, method.DeclaringType)
        builder.Append('.')
        AppendMethodName(builder, method)
        if method.IsGenericMethod {
            builder.Append("``").Append(method.GetGenericArguments().Length)
        }
        AppendParameterList(builder, method.GetParameters())
        if method is MethodInfo info && (method.Name == "op_Implicit" || method.Name == "op_Explicit") {
            builder.Append('~')
            AppendTypeReference(builder, info.ReturnType)
        }
        return builder.ToString()
    }

    /// Computes the `P:` DocID for a reflected property or indexer.
    /// @param property The reflected property.
    /// @returns The property DocID.
    func GetDocumentationId(property PropertyInfo) string {
        var property = property
        property = NormalizeToOpenGenericDeclaringType(property) ?? property
        let builder = StringBuilder("P:")
        AppendTypeDeclarationName(builder, property.DeclaringType)
        builder.Append('.').Append(EncodeName(property.Name))
        AppendParameterList(builder, property.GetIndexParameters())
        return builder.ToString()
    }

    /// Computes the `F:` DocID for a reflected field.
    /// @param field The reflected field.
    /// @returns The field DocID.
    func GetDocumentationId(field FieldInfo) string {
        var field = field
        field = NormalizeToOpenGenericDeclaringType(field) ?? field
        let builder = StringBuilder("F:")
        AppendTypeDeclarationName(builder, field.DeclaringType)
        builder.Append('.').Append(EncodeName(field.Name))
        return builder.ToString()
    }

    /// Computes the `E:` DocID for a reflected event.
    /// @param event The reflected event.
    /// @returns The event DocID.
    func GetDocumentationId(event EventInfo) string? {
        var event = event
        event = NormalizeToOpenGenericDeclaringType(event) ?? event
        let builder = StringBuilder("E:")
        AppendTypeDeclarationName(builder, event.DeclaringType)
        builder.Append('.').Append(EncodeName(event.Name))
        return builder.ToString()
    }

    // Normalizes a constructed generic type (e.g. List<int>) to its generic definition
    // (List<>) so the declaration-name path produces arity-backticked output (`List`1`)
    // that matches XML doc keys. Non-generic and already-open generic types pass through
    // unchanged. Null in → null out (callers handle the null DeclaringType case).
    private func NormalizeToGenericDefinition(type Type) Type? {
        if type != nil && type.IsGenericType == true && type.IsGenericTypeDefinition == false {
            return type.GetGenericTypeDefinition()
        }
        return type
    }

    // Re-resolves a member reflected off a *constructed* generic type to the equivalent
    // member on the generic *definition*. This is what makes DocIDs match the XML doc
    // keys for things like `typeof(List<int>).GetMethod("Add")`: not only must the
    // declaring type be `List`1`, but the parameter signature must be `(`0)` rather than
    // the bound `(System.Int32)`. Matching by metadata token within the same module is
    // the standard reflection trick for going from constructed → open form.
    // Returns null when the member is already open or normalization isn't possible.
    private func NormalizeToOpenGenericDeclaringType[T MemberInfo](member T) T? {
        let declaring = member.DeclaringType
        if !(declaring != nil && declaring.IsGenericType == true && declaring.IsGenericTypeDefinition == false) {
            return nil
        }
        var openType Type
        try {
            openType = declaring.GetGenericTypeDefinition()
        } catch (InvalidOperationException) {
            return nil
        }
        const AllDeclared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
        for candidate in openType.GetMembers(AllDeclared) {
            if candidate is T typed &&
                candidate.MetadataToken == member.MetadataToken &&
                candidate.Module == member.Module {
                return typed
            }
        }
        return nil
    }

    private func AppendMethodName(builder StringBuilder, method MethodBase) {
        if method.IsConstructor {
            builder.Append(
                if method.IsStatic {
                    "#cctor"
                } else {
                    "#ctor"
                }
            )
            return
        }
        builder.Append(EncodeName(method.Name))
    }

    private func AppendParameterList(builder StringBuilder, parameters[]ParameterInfo) {
        if parameters.Length == 0 {
            return
        }
        builder.Append('(')
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, parameters[i].ParameterType)
        }
        builder.Append(')')
    }

    // The declaration name is the dotted, arity-backticked path with no prefix and no
    // brace-substituted type arguments — used for `T:` ids and as the container path of
    // member ids (e.g. "System.Collections.Generic.List`1").
    private func AppendTypeDeclarationName(builder StringBuilder, type Type?) {
        let chain = NestingChain(type)
        let outermost = chain[0]
        if !string.IsNullOrEmpty(outermost.Namespace) {
            builder.Append(outermost.Namespace).Append('.')
        }
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(StripArity(level.Name))
            let arity = LevelArity(level)
            if arity > 0 {
                builder.Append('`').Append(arity)
            }
        }
    }

    // A type reference as it appears in a parameter/return position: generic parameters
    // become `n (type) / ``n (method); constructed generics use brace-substituted args;
    // by-ref/array/pointer carry their suffixes.
    private func AppendTypeReference(builder StringBuilder, type Type?) {
        if type == nil {
            return
        }
        if type.IsByRef {
            AppendTypeReference(builder, type.GetElementType())
            builder.Append('@')
            return
        }
        if type.IsPointer {
            AppendTypeReference(builder, type.GetElementType())
            builder.Append('*')
            return
        }
        if type.IsArray {
            AppendTypeReference(builder, type.GetElementType())
            AppendArraySuffix(builder, type)
            return
        }
        if type.IsGenericParameter {
            builder.Append(
                if type.DeclaringMethod != nil {
                    "``"
                } else {
                    "`"
                }
            )
                .Append(type.GenericParameterPosition)
            return
        }
        AppendConstructedTypeReference(builder, type)
    }

    private func AppendConstructedTypeReference(builder StringBuilder, type Type) {
        let chain = NestingChain(type)
        let outermost = chain[0]
        if !string.IsNullOrEmpty(outermost.Namespace) {
            builder.Append(outermost.Namespace).Append('.')
        }
        let allArgs = if type.IsGenericType {
            type.GetGenericArguments()
        } else {
            Array.Empty[Type]()
        }
        var consumed = 0
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(StripArity(level.Name))
            let arity = LevelArity(level)
            if arity == 0 {
                continue
            }
            if type.IsGenericTypeDefinition {
                builder.Append('`').Append(arity)
                continue
            }
            builder.Append('{')
            for var a = 0; a < arity; a++ {
                if a > 0 {
                    builder.Append(',')
                }
                AppendTypeReference(builder, allArgs[consumed + a])
            }
            builder.Append('}')
            consumed += arity
        }
    }

    private func AppendArraySuffix(builder StringBuilder, array Type) {
        if array.IsSZArray {
            builder.Append("[]")
            return
        }
        let rank = array.GetArrayRank()
        builder.Append('[').Append(string.Join(",", Enumerable.Repeat("0:", rank))).Append(']')
    }

    private func NestingChain(type Type?) List[Type] {
        let chain = List[Type]()
        for var current Type? = type; current != nil; current = current!!.DeclaringType {
            chain.Insert(0, current)
        }
        return chain
    }

    private func LevelArity(level Type) int32 {
        let own = if level.IsGenericType {
            level.GetGenericArguments().Length
        } else {
            0
        }
        let enclosing = if level.DeclaringType is {IsGenericType: true} declaring {
            declaring.GetGenericArguments().Length
        } else {
            0
        }
        return own - enclosing
    }

    private func StripArity(name string) string {
        let tick = name.IndexOf('`')
        return if tick >= 0 {
            name.Substring(0, tick)
        } else {
            name
        }
    }

    // Explicit interface implementations encode the interface in the member name:
    // '.' becomes '#', and when the implemented interface is generic, reflection spells
    // its type arguments with angle brackets/commas which Roslyn mangles as '{' / '}' /
    // '@' (e.g. ICollection<KeyValuePair<TKey,TValue>>.Add becomes
    // System#Collections#Generic#ICollection{...KeyValuePair{TKey@TValue}}#Add).
    // None of '<', '>', ',' ever appear in an ordinary member name, so the uniform
    // replacement is safe for non-EII names too.
    private func EncodeName(name string) string {
        return name.Replace('.', '#').Replace('<', '{').Replace('>', '}').Replace(',', '@')
    }
}
