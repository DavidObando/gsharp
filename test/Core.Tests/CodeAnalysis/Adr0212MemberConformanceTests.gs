// <copyright file="Adr0212MemberConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// ADR-0212 slice S4, differential conformance: the member queries must agree with the binder. For every
/// call whose callee the binder recorded, (cref:SemanticModel.GetMemberGroup) must hold that callee. For
/// every member name selected from a receiver whose type the binder recorded,
/// (cref:SemanticModel.LookupMembers) at that name must hold the member the binder bound. The corpus is
/// every program in `samples/` and the language server's own sources as one compilation. A mismatch is
/// reported by category so a fix lands on a shared rule.
open class Adr0212MemberConformanceTests {
    @Fact
    func MemberQueries_AgreeWithTheBinder_OnTheSamples() {
        let mismatches = List[string]()
        var compared = 0
        for file in Directory.GetFiles(Path.Combine(RepositoryRoot(), "samples"), "*.gs").OrderBy(
            (f string) -> f,
            StringComparer.Ordinal
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            compared += CompareCompilation(Compilation(tree), mismatches)
        }
        Assert.True(compared > 500, "compared ${compared} members")
        AssertNoMismatches(mismatches)
    }

    @Fact
    func MemberQueries_AgreeWithTheBinder_OnTheLanguageServerSources() {
        let mismatches = List[string]()
        let directory = Path.Combine(RepositoryRoot(), "src", "LanguageServer")
        let trees = Directory
            .GetFiles(directory, "*.gs")
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .Select((f string) -> SyntaxTree.Parse(SourceText.From(File.ReadAllText(f), f)))
            .ToArray()
        let compared = CompareCompilation(Compilation(trees), mismatches)
        Assert.True(compared > 1000, "compared ${compared} members")
        AssertNoMismatches(mismatches)
    }

    shared {
        private func RepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return directory!!.FullName
        }

        private func AssertNoMismatches(mismatches List[string]) {
            if mismatches.Count == 0 {
                return
            }
            let byCategory = mismatches
                .GroupBy((m string) -> m.Substring(0, m.IndexOf(" @ ", StringComparison.Ordinal)))
                .OrderBy((g IGrouping[string, string]) -> g.Key, StringComparer.Ordinal)
                .ToArray()
            let text = StringBuilder()
            text.AppendLine("${mismatches.Count} members disagree with the binder:")
            for group in byCategory {
                text.AppendLine("  ${group.Key}: ${group.Count()}")
                for example in group.Take(3) {
                    text.AppendLine("      " + example.Substring(example.IndexOf(" @ ", StringComparison.Ordinal) + 3))
                }
            }
            Assert.Fail(text.ToString())
        }

        /// Compares every tree of [`compilation`](paramref); returns the number of members compared.
        private func CompareCompilation(compilation Compilation, mismatches List[string]) int32 {
            var compared = 0
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let file = Path.GetFileName(tree.Text?.FileName ?? string.Empty)
                for node in tree.Root.DescendantNodes() {
                    if node is CallExpressionSyntax call {
                        compared += CompareGroup(model, call, file, mismatches)
                    }
                    if node is AccessorExpressionSyntax accessor {
                        compared += CompareMember(model, accessor, file, mismatches)
                    }
                }
            }
            return compared
        }

        private func CompareGroup(
            model SemanticModel,
            call CallExpressionSyntax,
            file string,
            mismatches List[string]
        ) int32 {
            let token = call.Identifier
            if token.IsMissing || token.Kind != SyntaxKind.IdentifierToken || call.Callee != nil {
                return 0
            }
            guard let called = model.GetSymbolInfo(token).Symbol else {
                return 0
            }
            if called is not(FunctionSymbol or ImportedFunctionSymbol) {
                return 0
            }
            if IsExtension(called) {
                return 0
            }
            let group = model.GetMemberGroup(call)
            let category = "group of " + called.GetType().Name
            if group.IsDefaultOrEmpty {
                mismatches.Add(category + " is empty @ ${file}:${token.Span.Start} '${token.Text}'")
            } else if !group.Any((g Symbol) -> Matches(g, called)) {
                mismatches.Add(category + " misses the callee @ ${file}:${token.Span.Start} '${token.Text}'")
            }
            return 1
        }

        private func CompareMember(
            model SemanticModel,
            accessor AccessorExpressionSyntax,
            file string,
            mismatches List[string]
        ) int32 {
            let token SyntaxToken? = switch accessor.RightPart {
                case name is NameExpressionSyntax: name.IdentifierToken
                case call is CallExpressionSyntax: call.Identifier
                default: default(SyntaxToken?)
            }
            if token == nil || token.IsMissing || token.Kind != SyntaxKind.IdentifierToken {
                return 0
            }
            guard let bound = model.GetSymbolInfo(token).Symbol else {
                return 0
            }
            if bound is not(FieldSymbol or PropertySymbol or EventSymbol or FunctionSymbol or ImportedFunctionSymbol) {
                return 0
            }
            let receiverType = model.GetReceiverTypeInfo(accessor.LeftPart).Type
            if receiverType == nil || receiverType is TypeParameterSymbol {
                return 0
            }
            if KnownGap(bound, receiverType) {
                return 0
            }
            let members = model.LookupMembers(token.Span.Start, receiverType, token.ValueText)
            let category = "member " + bound.GetType().Name + " of " + receiverType.GetType().Name
            if members.IsDefaultOrEmpty {
                mismatches.Add(category + " found nothing @ ${file}:${token.Span.Start} '${token.Text}'")
            } else if !members.Any((m Symbol) -> Matches(m, bound)) {
                mismatches.Add(category + " misses the bound member @ ${file}:${token.Span.Start} '${token.Text}'")
            }
            return 1
        }

        /// An extension function or method is not a member of its receiver type (ADR-0212 question 12).
        private func IsExtension(called Symbol) bool -> switch called {
            case function is ImportedFunctionSymbol: function.Method.IsDefined(
                typeof(System.Runtime.CompilerServices.ExtensionAttribute),
                false
            )
            case function is FunctionSymbol: function.ExtensionReceiverType != nil
            default: false
        }

        /// The shapes that the query leaves out for now, each one also missing from the completion list that
        /// the query replaces. Each has a follow-up issue; a shape that is not listed here must conform.
        /// - A member of a base class, or of a base interface, that comes from an imported type.
        /// - A default method of an interface, called on the class that implements it.
        /// - The built-in members of the slice, array, map, channel and sequence types.
        private func KnownGap(bound Symbol, receiverType TypeSymbol) bool {
            if IsExtension(bound) {
                return true
            }
            if receiverType is SliceTypeSymbol or ArrayTypeSymbol or MapTypeSymbol or ChannelTypeSymbol or SequenceTypeSymbol {
                return true
            }
            if ImportedOf(bound) is {} imported {
                if receiverType is StructSymbol {
                    return true
                }
                if imported.DeclaringType is {} declaring && receiverType.ClrType is {} receiverClr &&
                    declaring.IsInterface && !declaring.IsEquivalentTo(receiverClr) {
                    return true
                }
            }
            return bound is FunctionSymbol && receiverType is StructSymbol && bound.ContainingType is InterfaceSymbol
        }

        /// Two symbols are the same member when they have the same name and the same declaration: the
        /// declaring syntax of a source member, the reflected member of an imported one.
        private func Matches(candidate Symbol, bound Symbol) bool {
            if object.ReferenceEquals(candidate, bound) {
                return true
            }
            if !string.Equals(candidate.Name, bound.Name, StringComparison.Ordinal) {
                return false
            }
            let candidateMember = ImportedOf(candidate)
            let boundMember = ImportedOf(bound)
            if candidateMember != nil || boundMember != nil {
                return candidateMember != nil &&
                    boundMember != nil &&
                    candidateMember.MetadataToken == boundMember.MetadataToken &&
                    string.Equals(candidateMember.Module.Name, boundMember.Module.Name, StringComparison.Ordinal)
            }
            let candidateSyntax = candidate.DeclaringSyntaxNodes
            let boundSyntax = bound.DeclaringSyntaxNodes
            if !candidateSyntax.IsDefaultOrEmpty && !boundSyntax.IsDefaultOrEmpty {
                return object.ReferenceEquals(candidateSyntax[0], boundSyntax[0])
            }
            return candidate.GetType() == bound.GetType()
        }

        private func ImportedOf(symbol Symbol) MemberInfo? -> switch symbol {
            case function is ImportedFunctionSymbol: function.Method
            case property is PropertySymbol: property.ImportedMember
            case field is FieldSymbol: field.ImportedMember
            case clrEvent is EventSymbol: clrEvent.ImportedMember
            default: default(MemberInfo?)
        }
    }
}
