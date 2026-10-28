// <copyright file="RegionEffectKindTable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

/// What one kind of syntax node does to the narrowing facts of a region
/// (ADR-0213 section 7, rule W6).
internal enum RegionEffectClass {
    /// A token or a keyword. It has no effect.
    Token,
    /// The node changes nothing by itself. Its children do.
    Structural,
    /// The node declares names for the nodes that follow it (rule W1).
    Declaration,
    /// The node writes a plain variable by name.
    RootWrite,
    /// The node writes a member, an element or a field.
    MemberWrite,
    /// The node writes through a pointer or a reference of unknown origin.
    PointerWrite,
    /// The node takes the address of a variable, or passes it by reference.
    Alias,
    /// The node runs code that the walker cannot see (rule W4).
    Call,
    /// The node reads a member or an element (rule W5). Every such read is an unknown getter.
    MemberRead,
    /// The node creates a function whose body runs later (rule W7).
    Closure,
    /// The node ends the path or records an edge.
    Jump,
    /// A loop statement. The scanner treats it as a nested region.
    Loop,
    /// A `try` statement, or one of its clauses (rule W8).
    Handler,
    /// A declaration of a type or a member. It cannot occur in a statement list.
    DeclarationOnly,
    /// The walker does not list the kind (rule W6). A region with such a node loses every fact.
    Unknown
}

/// The closed list of ADR-0213 rule W6. Each syntax kind that is not a token
/// has one entry. A kind that the table does not list has the class
/// `Unknown`, which empties the entry state of the region. A test in
/// Core.Tests enumerates every `SyntaxKind`, so a new kind cannot be added
/// without choosing its class.
/// @remarks The class decides how the scanner treats a node. The scanner
/// holds the details of each class, such as which child declares a name.
internal shared class RegionEffectKindTable {
    private let classes Dictionary[SyntaxKind, RegionEffectClass] = Build()

    /// Gets the class of a syntax kind. A token or keyword kind has the class `Token`.
    /// A kind that the table does not list has the class `Unknown`.
    func Classify(kind SyntaxKind) RegionEffectClass {
        if IsTokenKind(kind) {
            return RegionEffectClass.Token
        }
        return if classes.TryGetValue(kind, out var effectClass) {
            effectClass
        } else {
            RegionEffectClass.Unknown
        }
    }

    /// Whether the kind is a token or a keyword, which the table does not list.
    func IsTokenKind(kind SyntaxKind) bool {
        let name = kind.ToString()
        return name.EndsWith("Token", StringComparison.Ordinal) || name.EndsWith("Keyword", StringComparison.Ordinal)
    }

    /// Whether the table lists a non-token kind explicitly.
    func IsListed(kind SyntaxKind) bool -> IsTokenKind(kind) || classes.ContainsKey(kind)

    /// Gets the listed non-token kinds, sorted by name in ordinal order.
    func ListedKindNames()[]string {
        let names = List[string]()
        for entry in classes {
            names.Add(entry.Key.ToString())
        }
        names.Sort(StringComparer.Ordinal)
        return names.ToArray()
    }

    private func Add(
        table Dictionary[SyntaxKind, RegionEffectClass],
        effectClass RegionEffectClass,
        kinds[]SyntaxKind
    ) {
        for kind in kinds {
            table.Add(kind, effectClass)
        }
    }

    private func Build() Dictionary[SyntaxKind, RegionEffectClass] {
        let table = Dictionary[SyntaxKind, RegionEffectClass]()
        Add(
            table,
            RegionEffectClass.Structural,
            []SyntaxKind{
                SyntaxKind.CompilationUnit,
                SyntaxKind.GlobalStatement,
                SyntaxKind.ExpressionStatement,
                SyntaxKind.UnaryExpression,
                SyntaxKind.BinaryExpression,
                SyntaxKind.ParenthesizedExpression,
                SyntaxKind.CheckedExpression,
                SyntaxKind.UncheckedExpression,
                SyntaxKind.LiteralExpression,
                SyntaxKind.NameExpression,
                SyntaxKind.GenericNameExpression,
                SyntaxKind.ArrayCreationExpression,
                SyntaxKind.StackAllocExpression,
                SyntaxKind.MapCreationExpression,
                SyntaxKind.MapEntry,
                SyntaxKind.RangeExpression,
                SyntaxKind.FromEndIndexExpression,
                SyntaxKind.TypeClause,
                SyntaxKind.TypeParameter,
                SyntaxKind.TypeParameterList,
                SyntaxKind.TypeArgumentList,
                SyntaxKind.BlockStatement,
                SyntaxKind.IfStatement,
                SyntaxKind.ElseClause,
                SyntaxKind.BreakStatement,
                SyntaxKind.ContinueStatement,
                SyntaxKind.FallthroughStatement,
                SyntaxKind.ReturnStatement,
                SyntaxKind.SwitchStatement,
                SyntaxKind.SwitchCase,
                SyntaxKind.SwitchExpression,
                SyntaxKind.SwitchExpressionArm,
                SyntaxKind.ConstantPattern,
                SyntaxKind.TypeOrConstantPattern,
                SyntaxKind.DiscardPattern,
                SyntaxKind.TypePattern,
                SyntaxKind.PropertyPattern,
                SyntaxKind.PropertyPatternField,
                SyntaxKind.RelationalPattern,
                SyntaxKind.ListPattern,
                SyntaxKind.SlicePattern,
                SyntaxKind.BinaryPattern,
                SyntaxKind.NotPattern,
                SyntaxKind.ParenthesizedPattern,
                SyntaxKind.ThrowStatement,
                SyntaxKind.RethrowStatement,
                SyntaxKind.ThrowExpression,
                SyntaxKind.FinallyClause,
                SyntaxKind.StructLiteralContentElement,
                SyntaxKind.FieldInitializer,
                SyntaxKind.TupleLiteralExpression,
                SyntaxKind.NamedTupleElement,
                SyntaxKind.NamedArgumentExpression,
                SyntaxKind.WithExpression,
                SyntaxKind.ChannelCreationExpression,
                SyntaxKind.MakeChannelExpression,
                SyntaxKind.ScopeStatement,
                SyntaxKind.TypeOfExpression,
                SyntaxKind.NameOfExpression,
                SyntaxKind.SizeOfExpression,
                SyntaxKind.ConditionalExpression,
                SyntaxKind.PropertyInitializer,
                SyntaxKind.IsExpression,
                SyntaxKind.AsExpression,
                SyntaxKind.IfExpression,
                SyntaxKind.BlockExpression,
                SyntaxKind.DefaultExpression,
                SyntaxKind.ExpressionCollectionElement,
                SyntaxKind.SpreadElementExpression,
                SyntaxKind.KeyedCollectionElement,
                SyntaxKind.IndexedCollectionElement,
                SyntaxKind.MemberCollectionElement,
                SyntaxKind.Annotation,
                SyntaxKind.AnnotationTarget
            }
        )
        Add(
            table,
            RegionEffectClass.Declaration,
            []SyntaxKind{
                SyntaxKind.VariableDeclaration,
                SyntaxKind.IfLetStatement,
                SyntaxKind.GuardLetStatement,
                SyntaxKind.IfLetBindingClause,
                SyntaxKind.IfLetExpression,
                SyntaxKind.MultiAssignmentDeclarationExpression,
                SyntaxKind.VarPattern,
                SyntaxKind.TupleDeconstructionStatement,
                SyntaxKind.NamedDeconstructionStatement,
                SyntaxKind.NamedDeconstructionField,
                SyntaxKind.Parameter,
                SyntaxKind.TupleDeconstructionPattern,
                SyntaxKind.FixedStatement,
                SyntaxKind.UsingStatement
            }
        )
        Add(
            table,
            RegionEffectClass.RootWrite,
            []SyntaxKind{
                SyntaxKind.AssignmentExpression,
                SyntaxKind.EventSubscriptionExpression,
                SyntaxKind.NullCoalescingAssignmentExpression,
                SyntaxKind.MultiAssignmentStatement
            }
        )
        Add(
            table,
            RegionEffectClass.MemberWrite,
            []SyntaxKind{
                SyntaxKind.IndexAssignmentExpression,
                SyntaxKind.MemberIndexAssignmentExpression,
                SyntaxKind.CompoundIndexAssignmentExpression,
                SyntaxKind.MemberFieldAssignmentExpression,
                SyntaxKind.FieldAssignmentExpression
            }
        )
        Add(
            table,
            RegionEffectClass.PointerWrite,
            []SyntaxKind{SyntaxKind.IndirectAssignmentExpression, SyntaxKind.IndirectCompoundAssignmentExpression}
        )
        Add(
            table,
            RegionEffectClass.Alias,
            []SyntaxKind{SyntaxKind.RefArgumentExpression, SyntaxKind.ConditionalRefArgumentExpression}
        )
        Add(
            table,
            RegionEffectClass.Call,
            []SyntaxKind{
                SyntaxKind.CallExpression,
                SyntaxKind.InterpolatedStringExpression,
                SyntaxKind.StructLiteralExpression,
                SyntaxKind.AnonymousClassExpression,
                SyntaxKind.AnonymousClassMemberInitializer,
                SyntaxKind.ObjectCreationExpression,
                SyntaxKind.BaseInterfaceCallExpression,
                SyntaxKind.BaseClassCallExpression,
                SyntaxKind.CollectionInitializerExpression,
                SyntaxKind.AwaitExpression,
                SyntaxKind.YieldStatement,
                SyntaxKind.GoStatement,
                SyntaxKind.ChannelReceiveExpression,
                SyntaxKind.ChannelSendStatement,
                SyntaxKind.SelectStatement,
                SyntaxKind.SelectCase,
                SyntaxKind.DeferStatement,
                SyntaxKind.LockStatement,
                SyntaxKind.AwaitUsingStatement
            }
        )
        Add(
            table,
            RegionEffectClass.MemberRead,
            []SyntaxKind{SyntaxKind.AccessorExpression, SyntaxKind.IndexExpression, SyntaxKind.FieldAccessExpression}
        )
        Add(
            table,
            RegionEffectClass.Closure,
            []SyntaxKind{SyntaxKind.FunctionLiteralExpression, SyntaxKind.LambdaExpression}
        )
        Add(table, RegionEffectClass.Jump, []SyntaxKind{SyntaxKind.GotoStatement, SyntaxKind.LabeledStatement})
        Add(
            table,
            RegionEffectClass.Loop,
            []SyntaxKind{
                SyntaxKind.ForInfiniteStatement,
                SyntaxKind.ForEllipsisStatement,
                SyntaxKind.ForConditionStatement,
                SyntaxKind.ForClauseStatement,
                SyntaxKind.ForRangeStatement,
                SyntaxKind.ForTupleRangeStatement,
                SyntaxKind.WhileLetStatement,
                SyntaxKind.WhileStatement,
                SyntaxKind.DoWhileStatement,
                SyntaxKind.AwaitForRangeStatement
            }
        )
        Add(table, RegionEffectClass.Handler, []SyntaxKind{SyntaxKind.TryStatement, SyntaxKind.CatchClause})
        Add(
            table,
            RegionEffectClass.DeclarationOnly,
            []SyntaxKind{
                SyntaxKind.PackageDeclaration,
                SyntaxKind.ImportDeclaration,
                SyntaxKind.TypeAliasDeclaration,
                SyntaxKind.EnumDeclaration,
                SyntaxKind.EnumMember,
                SyntaxKind.StructDeclaration,
                SyntaxKind.InterfaceDeclaration,
                SyntaxKind.FieldDeclaration,
                SyntaxKind.PropertyDeclaration,
                SyntaxKind.EventDeclaration,
                SyntaxKind.PropertyAccessor,
                SyntaxKind.EventAccessor,
                SyntaxKind.SharedBlock,
                SyntaxKind.StaticInitializerBlock,
                SyntaxKind.ConstructorDeclaration,
                SyntaxKind.DeinitDeclaration,
                SyntaxKind.DelegateDeclaration
            }
        )
        // A local function is a closure whose name is visible to the statements after it.
        table.Add(SyntaxKind.FunctionDeclaration, RegionEffectClass.Closure)
        return table
    }
}
