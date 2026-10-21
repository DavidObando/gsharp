package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// Cached property readers contain CLR node types, never source symbols.
internal class BoundNodeAccessors {
    private init(symbolProperties[](BoundNode) -> object?, boundNodeProperties[](BoundNode) -> object?) {
        SymbolProperties = symbolProperties
        BoundNodeProperties = boundNodeProperties
    }

    prop SymbolProperties[](BoundNode) -> object? {
        get;
    }
    prop BoundNodeProperties[](BoundNode) -> object? {
        get;
    }

    shared {
        private let cache ConcurrentDictionary[Type, BoundNodeAccessors] = ConcurrentDictionary[
            Type,
            BoundNodeAccessors
        ]()

        func Get(type Type) BoundNodeAccessors -> cache.GetOrAdd(
            type,
            (nodeType Type) -> {
                let symbolGetters = List[(BoundNode) -> object?]()
                let boundGetters = List[(BoundNode) -> object?]()
                for property in nodeType.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                    if property.GetIndexParameters().Length != 0 {
                        continue
                    }
                    let getterProperty = property
                    if typeof(Symbol).IsAssignableFrom(property.PropertyType) {
                        symbolGetters.Add((node BoundNode) -> getterProperty.GetValue(node))
                    } else if typeof(BoundNode).IsAssignableFrom(property.PropertyType) {
                        boundGetters.Add((node BoundNode) -> getterProperty.GetValue(node))
                    }
                }
                return BoundNodeAccessors(symbolGetters.ToArray(), boundGetters.ToArray())
            }
        )
    }
}

/// Immutable descriptions of a body's anchors and nodes with symbol readers.
/// Readers run after binding; inference and body-cache repointing can change their results.
internal class BoundSourceOwnership {
    private init(syntaxTrees ImmutableArray[SyntaxTree], symbolNodes ImmutableArray[BoundNode], recordVisits int64) {
        SyntaxTrees = syntaxTrees
        SymbolNodes = symbolNodes
        RecordVisits = recordVisits
    }

    prop SyntaxTrees ImmutableArray[SyntaxTree] {
        get;
    }
    prop SymbolNodes ImmutableArray[BoundNode] {
        get;
    }
    prop RecordVisits int64 {
        get;
    }

    internal class Collector : BoundTreeWalker {
        private var firstTree SyntaxTree?
        private var otherTrees HashSet[SyntaxTree]?
        private var symbolNodes List[BoundNode]?
        private var recordVisits int64

        func Record(node BoundNode?) {
            if node == nil {
                return
            }
            recordVisits++
            if node.Syntax is {} syntax {
                let tree = syntax.SyntaxTree
                if firstTree == nil {
                    firstTree = tree
                } else if !object.ReferenceEquals(firstTree, tree) {
                    let others = otherTrees ?? HashSet[SyntaxTree](ReferenceEqualityComparer.Instance)
                    otherTrees = others
                    others.Add(tree)
                }
            }
            if BoundNodeAccessors.Get(node.GetType()).SymbolProperties.Length != 0 {
                let nodes = symbolNodes ?? List[BoundNode]()
                symbolNodes = nodes
                nodes.Add(node)
            }
        }

        func Complete() BoundSourceOwnership {
            var trees = ImmutableArray[SyntaxTree].Empty
            if firstTree is {} first {
                if otherTrees is {} others {
                    let builder = ImmutableArray.CreateBuilder[SyntaxTree](others.Count + 1)
                    builder.Add(first)
                    for tree in others {
                        builder.Add(tree)
                    }
                    trees = builder.MoveToImmutable()
                } else {
                    trees = ImmutableArray.Create(first)
                }
            }
            return BoundSourceOwnership(
                trees,
                if symbolNodes is {} nodes {
                    nodes.ToImmutableArray()
                } else {
                    ImmutableArray[BoundNode].Empty
                },
                recordVisits
            )
        }

        override func Visit(node BoundNode?) {
            Record(node)
            base.Visit(node)
        }

        override func VisitStatement(node BoundStatement?) {
            Record(node)
            base.VisitStatement(node)
        }

        override func VisitExpression(node BoundExpression?) {
            Record(node)
            base.VisitExpression(node)
        }

        override func VisitPattern(node BoundPattern?) {
            Record(node)
            base.VisitPattern(node)
        }
    }
}
