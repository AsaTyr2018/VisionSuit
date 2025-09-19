import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from './api';
import type { User } from '../types/api';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const STORAGE_KEY = 'visionsuit.auth.token';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to access localStorage:', error);
      return null;
    }
  });
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    const loadUser = async () => {
      if (!token) {
        setUser(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const { user: currentUser } = await api.getCurrentUser(token);
        if (!isActive) return;
        setUser(currentUser);
      } catch (error) {
        if (!isActive) return;
        console.warn('Failed to fetch current user', error);
        setUser(null);
        setToken(null);
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch (storageError) {
          console.warn('Failed to clear localStorage token', storageError);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    void loadUser();

    return () => {
      isActive = false;
    };
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    setToken(response.token);
    setUser(response.user);
    try {
      window.localStorage.setItem(STORAGE_KEY, response.token);
    } catch (error) {
      console.warn('Failed to persist auth token', error);
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to remove auth token', error);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) {
      setUser(null);
      return;
    }

    const { user: currentUser } = await api.getCurrentUser(token);
    setUser(currentUser);
  }, [token]);

  const value = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(user && token),
      isLoading,
      login,
      logout,
      refreshUser,
    }),
    [user, token, isLoading, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
};
