// <copyright file="DocumentContentService.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis

/// Service to maintain document content and share it across handlers.
open class DocumentContentService {
    private let documentContents ConcurrentDictionary[string, DocumentContent] = ConcurrentDictionary[
        string,
        DocumentContent
    ]()

    /// Gets all documents currently in the buffer.
    prop AllDocuments IEnumerable[KeyValuePair[string, DocumentContent]] -> this.documentContents

    /// Adds a document to the service buffer.
    /// @param key Document Uri.
    /// @param content Document content.
    /// @seealso DocumentContent
    func AddOrUpdate(key string, content DocumentContent) {
        this.documentContents.AddOrUpdate(key, content, (_ string, _ DocumentContent) -> content)
    }

    /// Gets the content of a document if it exists in the buffer.
    /// @param key Document Uri.
    /// @param content Document content.
    /// @returns Whether or not the operation succeeded.
    /// @seealso DocumentContent
    open func TryGet(key string, @NotNullWhen(true) out content DocumentContent?) bool {
        return this.documentContents.TryGetValue(key, out content)
    }

    /// Removes a document content.
    /// @param key Document Uri.
    /// @returns Whether or not the operation succeeded.
    func TryRemove(key string) bool {
        return this.documentContents.TryRemove(key, out _)
    }
}
