package com.udbms;

/** role is optional and Oracle only: sysdba, sysoper, ... (needed to log in as SYS). */
public record ConnectRequest(String type, String host, Integer port, String database,
                             String username, String password, String uri, String role) {}
