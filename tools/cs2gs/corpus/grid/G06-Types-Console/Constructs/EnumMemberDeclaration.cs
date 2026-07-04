// inventory: EnumMemberDeclaration — explicit values, negative value, member referencing member
using System;

namespace Corpus.Grid06
{
    public enum StatusCode
    {
        Unknown = -1,
        Ok = 200,
        NotFound = 404,
        ServerError = 500,
        DefaultError = ServerError,
    }

    [Flags]
    public enum AccessMode
    {
        None = 0,
        Read = 1 << 2,
        Write = 1 << 3,
        ReadWrite = Read | Write,
    }

    public static class EnumMemberDeclarationFixture
    {
        public static void Run()
        {
            Console.WriteLine("EnumMemberDeclaration: unknown=" + ((int)StatusCode.Unknown).ToString());
            Console.WriteLine("EnumMemberDeclaration: ok=" + ((int)StatusCode.Ok).ToString());
            Console.WriteLine("EnumMemberDeclaration: notfound=" + ((int)StatusCode.NotFound).ToString());
            Console.WriteLine("EnumMemberDeclaration: default-error=" + ((int)StatusCode.DefaultError).ToString());
            Console.WriteLine("EnumMemberDeclaration: alias-equals=" + (StatusCode.DefaultError == StatusCode.ServerError ? "true" : "false"));
            Console.WriteLine("EnumMemberDeclaration: read=" + ((int)AccessMode.Read).ToString());
            Console.WriteLine("EnumMemberDeclaration: write=" + ((int)AccessMode.Write).ToString());
            Console.WriteLine("EnumMemberDeclaration: readwrite=" + ((int)AccessMode.ReadWrite).ToString());
            Console.WriteLine("EnumMemberDeclaration: readwrite-is-flags-combo=" + (AccessMode.ReadWrite == (AccessMode.Read | AccessMode.Write) ? "true" : "false"));
        }
    }
}
