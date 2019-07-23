// <copyright file="DocumentContentService.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LSP
{
    using System.Collections.Concurrent;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Service to maintain document content and share it across handlers.
    /// </summary>
    internal class DocumentContentService
    {
        private readonly ConcurrentDictionary<string, DocumentContent> documentContents = new ConcurrentDictionary<string, DocumentContent>();

        /// <summary>
        /// Adds a document to the service buffer.
        /// </summary>
        /// <param name="key">Document Uri.</param>
        /// <param name="content">Document content.</param>
        /// <seealso cref="DocumentContent"/>
        public void AddOrUpdate(string key, DocumentContent content)
        {
            this.documentContents.AddOrUpdate(key, content, (aKey, oldValue) => content);
        }

        /// <summary>
        /// Gets the content of a document if it exists in the buffer.
        /// </summary>
        /// <param name="key">Document Uri.</param>
        /// <param name="content">Document content.</param>
        /// <returns>Whether or not the operation succeeded.</returns>
        /// <seealso cref="DocumentContent"/>
        public bool TryGet(string key, out DocumentContent content)
        {
            return this.documentContents.TryGetValue(key, out content);
        }

        /// <summary>
        /// Removes a document content.
        /// </summary>
        /// <param name="key">Document Uri.</param>
        /// <returns>Whether or not the operation succeeded.</returns>
        public bool TryRemove(string key)
        {
            return this.documentContents.TryRemove(key, out DocumentContent content);
        }
    }
}
