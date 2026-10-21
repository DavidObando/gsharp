package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Shares ordered import views within one binding pass.
internal class VisibleImportIndex {
    // Incremental binding creates a new scope chain after it re-points import declarations.
    private let ownByTree ImmutableDictionary[SyntaxTree, ImmutableArray[ImportSymbol]]
    private let implicitImports ImmutableArray[ImportSymbol]
    private let withoutTree ImmutableArray[ImportSymbol]
    private let visibleByTree ConcurrentDictionary[SyntaxTree, ImmutableArray[ImportSymbol]] =
    ConcurrentDictionary[SyntaxTree, ImmutableArray[ImportSymbol]]()

    internal init(parent VisibleImportIndex?, imports ImmutableArray[ImportSymbol]) {
        Parent = parent
        OwnCount = imports.Length
        let byTree = Dictionary[SyntaxTree, ImmutableArray[ImportSymbol].Builder]()
        let implicitBuilder = ImmutableArray.CreateBuilder[ImportSymbol]()
        for import_ in imports {
            if import_.Declaration is {} declaration {
                let tree = declaration.SyntaxTree
                if !byTree.TryGetValue(tree, out var bucket) {
                    bucket = ImmutableArray.CreateBuilder[ImportSymbol]()
                    bucket.AddRange(implicitBuilder)
                    byTree.Add(tree, bucket)
                }
                bucket.Add(import_)
            } else {
                implicitBuilder.Add(import_)
                for bucket in byTree.Values {
                    bucket.Add(import_)
                }
            }
        }
        ownByTree = byTree.ToImmutableDictionary(
            (pair KeyValuePair[SyntaxTree, ImmutableArray[ImportSymbol].Builder]) -> pair.Key,
            (pair KeyValuePair[SyntaxTree, ImmutableArray[ImportSymbol].Builder]) -> pair.Value.ToImmutable()
        )
        implicitImports = implicitBuilder.ToImmutable()
        withoutTree = (parent?.GetVisibleImports(nil) ?? ImmutableArray[ImportSymbol].Empty).AddRange(implicitImports)
        CompilationMeasurements.Count("imports.indexed", imports.Length)
    }

    internal prop Parent VisibleImportIndex? {
        get;
    }
    internal prop OwnCount int32 {
        get;
    }

    internal func GetVisibleImports(tree SyntaxTree?) ImmutableArray[ImportSymbol] {
        if tree == nil {
            return withoutTree
        }
        if visibleByTree.TryGetValue(tree, out var cached) {
            return cached
        }
        let own = if ownByTree.TryGetValue(tree, out var imports) {
            imports
        } else {
            implicitImports
        }
        let inherited = Parent?.GetVisibleImports(tree) ?? ImmutableArray[ImportSymbol].Empty
        let visible = inherited.AddRange(own)
        CompilationMeasurements.Count("imports.views-built")
        CompilationMeasurements.Count("imports.view-entries", own.Length)
        return visibleByTree.GetOrAdd(tree, visible)
    }
}
