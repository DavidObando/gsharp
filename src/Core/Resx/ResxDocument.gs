// <copyright file="ResxDocument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Resx

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Xml.Linq

/// A parsed `.resx` document (ADR-0142): the ordered set of real
/// resource entries, with Visual Studio's design-time-only metadata rows
/// (`<data name=">>...">`, produced by the WinForms/WPF
/// designer) and `<resheader>` rows filtered out.
class ResxDocument {
    private init(entries IReadOnlyList[ResxEntry]) {
        this.Entries = entries
    }

    /// Gets the resource entries, in document order.
    prop Entries IReadOnlyList[ResxEntry] {
        get;
    }

    shared {
        /// Parses resx XML text into a (cref:ResxDocument).
        /// @param xml The full text content of a `.resx` file.
        /// @returns The parsed document.
        /// @exception ArgumentNullException [`xml`](paramref) is `null`.
        func Parse(xml string?) ResxDocument {
            if xml == nil {
                throw ArgumentNullException("xml")
            }
            let root XElement? = XDocument.Parse(xml).Root
            let entries = List[ResxEntry]()
            if root != nil {
                for data in root.Elements("data") {
                    let name = string?(data.Attribute(XName?("name")!!))
                    if string.IsNullOrEmpty(name) {
                        continue
                    }
                    // Design-time-only metadata rows (e.g. ">>$this.Name",
                    // ">>treeView1.Nodes") record designer state, not resources —
                    // real ResX code generators skip them and so do we.
                    if name.StartsWith(">>", StringComparison.Ordinal) {
                        continue
                    }
                    let value = data.Element(XName?("value")!!)?.Value ?? string.Empty
                    let comment = data.Element(XName?("comment")!!)?.Value ?? string.Empty
                    let typeName = string?(data.Attribute(XName?("type")!!)) ?? string.Empty
                    let mimeType = string?(data.Attribute(XName?("mimetype")!!)) ?? string.Empty
                    entries.Add(ResxEntry(name, value, comment, typeName, mimeType))
                }
            }
            return ResxDocument(entries.ToImmutableArray())
        }

        /// Parses resx XML text loaded from disk.
        /// @param path The path to a `.resx` file.
        /// @returns The parsed document.
        func ParseFile(path string) ResxDocument {
            return Parse(File.ReadAllText(path))
        }
    }
}
