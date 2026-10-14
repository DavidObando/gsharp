// inventory: EnumMemberDeclaration — explicit values, negative value, member referencing member

package Corpus.Grid06

import System

enum StatusCode {
    Unknown = -1,
    Ok = 200,
    NotFound = 404,
    ServerError = 500,
    DefaultError = 500
}

@Flags
enum AccessMode {
    None,
    Read = 4,
    Write = 8,
    ReadWrite = 12
}

shared class EnumMemberDeclarationFixture {
    func Run() {
        Console.WriteLine("EnumMemberDeclaration: unknown=" + (int32(StatusCode.Unknown)).ToString())
        Console.WriteLine("EnumMemberDeclaration: ok=" + (int32(StatusCode.Ok)).ToString())
        Console.WriteLine("EnumMemberDeclaration: notfound=" + (int32(StatusCode.NotFound)).ToString())
        Console.WriteLine("EnumMemberDeclaration: default-error=" + (int32(StatusCode.DefaultError)).ToString())
        Console.WriteLine(
            "EnumMemberDeclaration: alias-equals=" +
                (
                if StatusCode.DefaultError == StatusCode.ServerError {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine("EnumMemberDeclaration: read=" + (int32(AccessMode.Read)).ToString())
        Console.WriteLine("EnumMemberDeclaration: write=" + (int32(AccessMode.Write)).ToString())
        Console.WriteLine("EnumMemberDeclaration: readwrite=" + (int32(AccessMode.ReadWrite)).ToString())
        Console.WriteLine(
            "EnumMemberDeclaration: readwrite-is-flags-combo=" +
                (
                if AccessMode.ReadWrite == (AccessMode.Read | AccessMode.Write) {
                    "true"
                } else {
                    "false"
                }
            )
        )
    }
}
